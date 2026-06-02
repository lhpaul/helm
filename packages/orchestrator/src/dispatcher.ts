import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { AgentResult, IAgentRuntime } from './runtime.js';
import type { ItemTransitionFn } from './specialists/spec-writer.js';
import { buildSpecWriterParams, handleSpecWriterResult } from './specialists/spec-writer.js';
import { buildPlanWriterParams, handlePlanWriterResult } from './specialists/plan-writer.js';
import type { PlanPublishOptions } from './specialists/plan-writer.js';
import {
  buildImplementerParams,
  handleImplementerResult,
  type ImplementerPublishOptions,
} from './specialists/implementer.js';
import {
  provisionCodeWorkspace,
  provisionReviewerWorkspace,
  artifactsDirFor,
} from './specialists/code-workspace.js';
import {
  fetchProductContext,
  fetchSpecForPlan,
  fetchPlanForImplementer,
} from './specialists/fetch-product-context.js';
import type { FetchFn } from './specialists/fetch-product-context.js';
import type { RunGit, RunGh } from './specialists/spec-publisher.js';
import {
  fanoutReviewers,
  shouldRemediate,
  type ReviewerKind,
} from './specialists/reviewer-fanout.js';
import { buildRemediationParams, handleRemediationResult } from './specialists/remediation.js';
import { findCodePRUrl, findArtifactPRUrl } from './specialists/pr-helpers.js';
import { runEarlyRemediation, type EarlyRemediatorKind } from './specialists/early-remediator.js';

// ── Stage → specialist mapping ────────────────────────────────────────────────

const STAGE_TO_SPECIALIST: Partial<Record<WorkflowStage, string>> = {
  discovery: 'spec-writer',
  'spec-ready': 'plan-writer',
  'plan-ready': 'implementer',
  'code-review': 'reviewer-fanout',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type DispatchInput = {
  externalId: string;
  productSlug: string;
  currentStage: WorkflowStage;
};

export type DispatchResult = {
  specialistId: string;
  status: 'done' | 'error' | 'cancelled';
  newStage?: WorkflowStage;
  costUsd: number;
  durationMs: number;
  /** URL of the knowledge-repo PR opened by the publish step, if applicable. */
  prUrl?: string;
  error?: string;
};

export type DispatchOptions = {
  /** Absolute path to the working directory for this run. Auto-created if absent. */
  workdir?: string;
  /** Override the specialist determined by stage mapping. */
  specialistId?: string;
  /**
   * Absolute path to the Helm data root (e.g. HELM_DATA_DIR or cwd/data).
   * Reserved for future specialists; currently unused by the spec-writer path.
   */
  dataRoot?: string;
  /**
   * GitHub personal access token (repo scope).
   * Required for product context fetching (Part A) and spec publishing (Part B).
   * When absent, both features are silently skipped.
   */
  githubToken?: string;
  /**
   * Injectable HTTP fetch function — for testing the context-fetch path.
   * Defaults to the global fetch.
   */
  fetchFn?: FetchFn;
  /**
   * Injectable git runner — for testing the publish path.
   * Defaults to the real git binary via execFile.
   */
  runGit?: RunGit;
  /**
   * Injectable gh runner — for testing the publish path.
   * Defaults to the real gh binary via execFile.
   */
  runGh?: RunGh;
  /**
   * Injectable function to fetch the tracker task (title + body) for the given
   * externalId. Called best-effort in the spec-writer branch — if absent, returns
   * null, or throws, the spec is written without a Task section (graceful degradation).
   *
   * Keeping this injectable avoids a hard dependency on any specific tracker
   * adapter and makes the dispatch path trivially testable without real network calls.
   */
  fetchTask?: (externalId: string) => Promise<{ title: string; body?: string } | null>;
  /**
   * Operator feedback for the early-stage remediators (spec-remediator /
   * plan-remediator, ADR-024). Required when dispatching either of those
   * specialists; ignored otherwise. The API route validates presence + bounds
   * (1..10000 chars); the dispatcher re-checks for non-empty as defense-in-depth.
   */
  feedback?: string;
};

// ── Status resolution ─────────────────────────────────────────────────────────

/**
 * Derives the honest DispatchResult.status from the agent result and the
 * post-agent handler outcome.
 *
 * Rules:
 *  - Agent cancelled or errored  → propagate that status directly.
 *  - Agent done but handler set an error field → 'error'.
 *  - Agent done and handler succeeded (no error) → 'done'.
 *
 * This guarantees that `status: 'done'` only appears when the entire dispatch
 * pipeline (agent + publish + transition) completed successfully — not just
 * when the agent finished without a protocol error.
 */
function resolveStatus(
  agentResult: AgentResult,
  handlerOutcome: { error?: string },
): DispatchResult['status'] {
  if (agentResult.status !== 'done') return agentResult.status;
  return handlerOutcome.error !== undefined ? 'error' : 'done';
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Looks up the specialist for the item's current stage, spawns the runtime,
 * awaits completion, and runs the post-completion handler.
 *
 * The `transition` argument is a function that satisfies ItemStore.transition —
 * injected to avoid a hard dependency on @helm/api internals.
 */
export async function dispatchStageHandler(
  item: DispatchInput,
  product: Product,
  runtime: IAgentRuntime,
  transition: ItemTransitionFn,
  options?: DispatchOptions,
): Promise<DispatchResult> {
  // Guard against path traversal — both productSlug (used in the publish path) and
  // externalId (used in workdir + branch names) must be safe filesystem components.
  // The (?!\.) lookahead blocks dot-segment values (`.`, `..`, `.hidden`, …) in
  // addition to the character-class restriction.
  const isSafePathPart = (v: string): boolean => /^(?!\.)[A-Za-z0-9._-]+$/.test(v);
  if (!isSafePathPart(item.productSlug) || !isSafePathPart(item.externalId)) {
    return {
      specialistId: options?.specialistId ?? 'none',
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: 'Invalid productSlug or externalId for filesystem path',
    };
  }

  const specialistId = options?.specialistId ?? STAGE_TO_SPECIALIST[item.currentStage];

  if (!specialistId) {
    return {
      specialistId: 'none',
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: `No specialist mapped for stage '${item.currentStage}'`,
    };
  }

  const workdir =
    options?.workdir ?? join(process.cwd(), 'data', 'worktrees', item.productSlug, item.externalId);

  await mkdir(workdir, { recursive: true });

  // Route to specialist
  if (specialistId === 'spec-writer') {
    // ── Part A: Fetch product context (README + agent instructions) ──────────
    // Skipped gracefully when no token is provided.
    const context = options?.githubToken
      ? await fetchProductContext(product, options.githubToken, options.fetchFn).catch((err) => {
          console.error(
            '[dispatcher] Failed to fetch product context (continuing without it):',
            err,
          );
          return undefined;
        })
      : undefined;

    // ── Part A2: Fetch tracker task (title + body) ───────────────────────────
    // Best-effort: null return (item absent in tracker) or network error → write
    // spec without a ## Task section, matching pre-ingestion behaviour.
    const taskRaw = options?.fetchTask
      ? await options.fetchTask(item.externalId).catch((err) => {
          console.error('[dispatcher] Failed to fetch tracker task (continuing without it):', err);
          return null;
        })
      : null;
    const task = taskRaw ?? undefined;

    const params = buildSpecWriterParams(item.externalId, product, workdir, context, task);
    const session = await runtime.spawn(params);
    const agentResult = await session.wait();

    // ── Part B: Publish spec to knowledge repo (optional) ────────────────────
    // publishSpecToPR internally clones to an isolated temp directory per call,
    // so no knowledgeRepoLocalPath is needed here — concurrency safety is
    // handled inside the function itself.
    const publishOpts = options?.githubToken
      ? {
          product,
          githubToken: options.githubToken,
          runGit: options.runGit,
          runGh: options.runGh,
        }
      : undefined;

    const specResult = await handleSpecWriterResult(
      item.externalId,
      agentResult,
      workdir,
      transition,
      publishOpts,
    );

    return {
      specialistId,
      status: resolveStatus(agentResult, specResult),
      newStage: specResult.newStage,
      costUsd: agentResult.totalCostUsd,
      durationMs: agentResult.durationMs,
      prUrl: specResult.prUrl,
      error: specResult.error,
    };
  }

  if (specialistId === 'plan-writer') {
    // Token is required — plan-writer needs it to fetch the spec AND publish the plan.
    if (!options?.githubToken) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: 'plan-writer requires GITHUB_TOKEN',
      };
    }

    // ── Fetch spec (required input) ──────────────────────────────────────────
    // Unlike product context, a missing spec is a hard error: we cannot write a
    // plan without the approved specification.
    let spec: string;
    try {
      const specContent = await fetchSpecForPlan(
        product,
        item.externalId,
        options.githubToken,
        options.fetchFn,
      );
      if (specContent === null) {
        return {
          specialistId,
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          error: `Spec not found for item '${item.externalId}' in knowledge repo`,
        };
      }
      spec = specContent;
    } catch (err) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `Failed to fetch spec: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ── Fetch product context (best-effort) ──────────────────────────────────
    const context = await fetchProductContext(product, options.githubToken, options.fetchFn).catch(
      (err) => {
        console.error('[dispatcher] Failed to fetch product context (continuing without it):', err);
        return undefined;
      },
    );

    const params = buildPlanWriterParams(item.externalId, product, workdir, spec, context);
    const session = await runtime.spawn(params);
    const agentResult = await session.wait();

    const publishOpts: PlanPublishOptions = {
      product,
      githubToken: options.githubToken,
      runGit: options.runGit,
      runGh: options.runGh,
    };

    const planResult = await handlePlanWriterResult(
      item.externalId,
      agentResult,
      workdir,
      transition,
      publishOpts,
    );

    return {
      specialistId,
      status: resolveStatus(agentResult, planResult),
      newStage: planResult.newStage,
      costUsd: agentResult.totalCostUsd,
      durationMs: agentResult.durationMs,
      prUrl: planResult.prUrl,
      error: planResult.error,
    };
  }

  if (specialistId === 'implementer') {
    // Token is required — implementer needs it to clone the code repo and open a PR.
    if (!options?.githubToken) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: 'implementer requires GITHUB_TOKEN',
      };
    }

    // Code repo is required — implementer clones it to write the implementation.
    const codeRepo = product.code_repos[0];
    if (!codeRepo) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: 'implementer requires at least one code_repo in product config',
      };
    }

    // ── Fetch plan (required input) ──────────────────────────────────────────
    let plan: string;
    try {
      const planContent = await fetchPlanForImplementer(
        product,
        item.externalId,
        options.githubToken,
        options.fetchFn,
      );
      if (planContent === null) {
        return {
          specialistId,
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          error: `Plan not found for item '${item.externalId}' in knowledge repo`,
        };
      }
      plan = planContent;
    } catch (err) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `Failed to fetch plan: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ── Fetch product context (best-effort) ──────────────────────────────────
    const context = await fetchProductContext(product, options.githubToken, options.fetchFn).catch(
      (err) => {
        console.error('[dispatcher] Failed to fetch product context (continuing without it):', err);
        return undefined;
      },
    );

    // ── Provision code workspace (shallow clone + impl branch) ───────────────
    // Provisioning happens BEFORE the stage transition so that a clone/network
    // failure leaves the item in plan-ready (re-dispatchable) instead of stuck
    // in in-development with no running agent and no workspace to clean up.
    let provisionedWorkspace = false;
    let actualWorkspacePath = '';

    try {
      const provisioned = await provisionCodeWorkspace(
        {
          externalId: item.externalId,
          codeRepo,
          githubToken: options.githubToken,
        },
        options.runGit,
      );
      actualWorkspacePath = provisioned.workspacePath;
      provisionedWorkspace = true;
    } catch (err) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `Failed to provision code workspace: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // All steps from here onwards run inside a try/finally that guarantees
    // the provisioned workspace is cleaned up regardless of outcome.
    try {
      // ── Transition plan-ready → in-development (after successful clone) ─────
      // Clone succeeded — signal "work in progress" before spawning the agent.
      // If this transition fails the finally block still cleans up the workspace.
      try {
        await transition({
          externalId: item.externalId,
          toStage: 'in-development',
          triggeredBy: 'specialist:implementer',
        });
      } catch (err) {
        return {
          specialistId,
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          error: `Failed to transition to in-development: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const params = buildImplementerParams(
        item.externalId,
        product,
        actualWorkspacePath,
        plan,
        context,
      );
      const session = await runtime.spawn(params);
      const agentResult = await session.wait();

      const publishOpts: ImplementerPublishOptions | undefined = options.githubToken
        ? {
            product,
            githubToken: options.githubToken,
            runGit: options.runGit,
            runGh: options.runGh,
          }
        : undefined;

      const implResult = await handleImplementerResult(
        item.externalId,
        agentResult,
        actualWorkspacePath,
        codeRepo,
        transition,
        publishOpts,
      );

      return {
        specialistId,
        status: resolveStatus(agentResult, implResult),
        newStage: implResult.newStage,
        costUsd: agentResult.totalCostUsd,
        durationMs: agentResult.durationMs,
        prUrl: implResult.prUrl,
        error: implResult.error,
      };
    } finally {
      // Always clean up the provisioned workspace (and its sibling artifacts
      // directory), even on error.
      if (provisionedWorkspace) {
        await rm(actualWorkspacePath, { recursive: true, force: true }).catch(() => {});
        await rm(artifactsDirFor(actualWorkspacePath), { recursive: true, force: true }).catch(
          () => {},
        );
      }
    }
  }

  if (specialistId === 'reviewer-fanout') {
    // Token is required — reviewer-fanout needs it to find the impl PR and post comments.
    if (!options?.githubToken) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: 'reviewer-fanout requires GITHUB_TOKEN',
      };
    }

    // Code repo is required — reviewers clone it to inspect the implementation.
    const codeRepo = product.code_repos[0];
    if (!codeRepo) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: 'reviewer-fanout requires at least one code_repo in product config',
      };
    }

    // Find the open impl PR — prerequisite for all reviewers.
    let prUrl: string;
    try {
      const found = await findCodePRUrl(
        { codeRepo, externalId: item.externalId, githubToken: options.githubToken },
        options?.runGh,
      );
      if (found === null) {
        return {
          specialistId,
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          error: `No open PR found for impl branch of item '${item.externalId}'`,
        };
      }
      prUrl = found;
    } catch (err) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `Failed to find impl PR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Fan-out across code/security/test reviewers in parallel.
    // The item stays in 'code-review' during the fan-out; the remediation gate
    // below decides whether to run remediation or wait for a human merge.
    const fanoutResult = await fanoutReviewers(
      item.externalId,
      product,
      prUrl,
      options.githubToken,
      runtime,
      options?.runGit,
      options?.runGh,
    );

    // If the fan-out failed at the block level (e.g. workspace provisioning) with
    // no reviewer results, there is nothing to gate on — return the failure as-is.
    if (fanoutResult.status === 'error' && fanoutResult.reviewerResults.length === 0) {
      return {
        specialistId,
        status: fanoutResult.status,
        costUsd: fanoutResult.costUsd,
        durationMs: fanoutResult.durationMs,
        prUrl: fanoutResult.prUrl,
        error: fanoutResult.error,
      };
    }

    // ── Remediation gate ──────────────────────────────────────────────────────
    // Any reviewer's CRITICAL/HIGH finding triggers remediation — code, security,
    // or test (ADR-019, extended by ADR-025 to cover the code-reviewer too).
    // No high findings → no-op; the item stays in code-review awaiting human merge.
    if (!shouldRemediate(fanoutResult.reviewerResults)) {
      return {
        specialistId,
        status: fanoutResult.status,
        costUsd: fanoutResult.costUsd,
        durationMs: fanoutResult.durationMs,
        prUrl: fanoutResult.prUrl,
        error: fanoutResult.error,
        // No newStage — item stays in code-review
      };
    }

    // Gate active. Provision the workspace BEFORE the transition so a clone/auth/
    // network failure leaves the item re-dispatchable in code-review rather than
    // stuck in remediation with no specialist mapped to recover it (mirrors the
    // S16b implementer provisioning-before-transition fix).
    let remediationWorkspace = '';
    try {
      const provisioned = await provisionReviewerWorkspace(
        { externalId: item.externalId, codeRepo, githubToken: options.githubToken },
        options.runGit,
      );
      remediationWorkspace = provisioned.workspacePath;
    } catch (err) {
      // Provisioning failed before any transition — the item stays in code-review
      // and can be re-dispatched.
      return {
        specialistId,
        status: 'error',
        costUsd: fanoutResult.costUsd,
        durationMs: fanoutResult.durationMs,
        prUrl: fanoutResult.prUrl,
        error: `Failed to provision remediation workspace: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Workspace exists — everything from here must clean it up on the way out.
    try {
      // Clone OK → transition into remediation. The whole remediation step runs
      // inside this same dispatch (composite Job): cost is summed across fan-out +
      // remediation; durationMs is the max of the two phases (fan-out ran its
      // reviewers in parallel, remediation runs after).
      try {
        await transition({
          externalId: item.externalId,
          toStage: 'remediation',
          triggeredBy: 'specialist:remediation',
        });
      } catch (err) {
        // Transition failed after provisioning — the finally below removes the
        // workspace; the item stays in code-review (re-dispatchable).
        return {
          specialistId,
          status: 'error',
          costUsd: fanoutResult.costUsd,
          durationMs: fanoutResult.durationMs,
          prUrl: fanoutResult.prUrl,
          error: `Failed to transition to remediation: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Inject the full code/security/test review bodies so the agent has
      // context. All three reviewer kinds flow to the remediator (ADR-025) — it
      // is the unified safety net behind the code-reviewer too.
      const findingsByKind = new Map<ReviewerKind, string>();
      for (const r of fanoutResult.reviewerResults) {
        if (r.commentBody) {
          findingsByKind.set(r.kind, r.commentBody);
        }
      }

      const params = buildRemediationParams(
        item.externalId,
        product,
        remediationWorkspace,
        prUrl,
        findingsByKind,
      );
      const session = await runtime.spawn(params);
      const agentResult = await session.wait();

      const remediationResult = await handleRemediationResult(
        item.externalId,
        agentResult,
        remediationWorkspace,
        prUrl,
        options.githubToken,
        codeRepo,
        options.runGit,
        options.runGh,
      );

      const aggregatedCost = fanoutResult.costUsd + remediationResult.costUsd;
      const aggregatedDuration = Math.max(fanoutResult.durationMs, remediationResult.durationMs);

      if (remediationResult.status !== 'done') {
        // Remediation failed — leave the item in 'remediation' (no return transition).
        return {
          specialistId,
          status: 'error',
          costUsd: aggregatedCost,
          durationMs: aggregatedDuration,
          prUrl: fanoutResult.prUrl,
          error: remediationResult.error,
        };
      }

      // Remediation succeeded — transition back to code-review for re-review/merge.
      try {
        await transition({
          externalId: item.externalId,
          toStage: 'code-review',
          triggeredBy: 'specialist:remediation',
        });
      } catch (err) {
        return {
          specialistId,
          status: 'error',
          costUsd: aggregatedCost,
          durationMs: aggregatedDuration,
          prUrl: fanoutResult.prUrl,
          error: `Failed to transition back to code-review: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return {
        specialistId,
        status: 'done',
        newStage: 'code-review',
        costUsd: aggregatedCost,
        durationMs: aggregatedDuration,
        prUrl: fanoutResult.prUrl,
      };
    } finally {
      await rm(remediationWorkspace, { recursive: true, force: true }).catch(() => {});
      await rm(artifactsDirFor(remediationWorkspace), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }

  // ── Early-stage remediators (ADR-024) ──────────────────────────────────────
  // spec-remediator / plan-remediator iterate an already-published spec/plan PR
  // in-place from operator feedback. They are operator-triggered (never reached
  // via STAGE_TO_SPECIALIST) — only dispatched when options.specialistId names
  // them. They do NOT transition the item: the artifact stays in its draft stage
  // until the operator merges the PR (the existing spec-ready/plan-ready flow).
  if (specialistId === 'spec-remediator' || specialistId === 'plan-remediator') {
    const kind: EarlyRemediatorKind = specialistId === 'spec-remediator' ? 'spec' : 'plan';
    const requiredStage: WorkflowStage = kind === 'spec' ? 'spec-draft' : 'plan-draft';

    // ── Stage validation ──────────────────────────────────────────────────────
    // A remediator only makes sense while its artifact PR is open and unmerged,
    // i.e. the item is still in the draft stage. Reject anything else with a
    // message that names the expected and actual stages.
    if (item.currentStage !== requiredStage) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `${specialistId} requires currentStage '${requiredStage}', got '${item.currentStage}'`,
      };
    }

    // ── Feedback validation (defense-in-depth; API also validates) ────────────
    const feedback = options?.feedback?.trim();
    if (!feedback) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `${specialistId} requires non-empty feedback`,
      };
    }

    // ── Token is required — needed to clone the knowledge repo and push edits ─
    if (!options?.githubToken) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `${specialistId} requires GITHUB_TOKEN`,
      };
    }

    // ── Resolve the open artifact PR (GitHub is the source of truth) ──────────
    let prUrl: string;
    try {
      const found = await findArtifactPRUrl(
        {
          knowledgeRepo: product.knowledge_repo,
          externalId: item.externalId,
          kind,
          githubToken: options.githubToken,
        },
        options?.runGh,
      );
      if (found === null) {
        const branch =
          kind === 'spec' ? `helm/spec/${item.externalId}` : `helm/plan/${item.externalId}`;
        return {
          specialistId,
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          error: `no open ${kind} PR found for ${item.externalId} on ${branch}`,
        };
      }
      prUrl = found;
    } catch (err) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `Failed to find ${kind} PR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ── Fetch product context (best-effort) ───────────────────────────────────
    const context = await fetchProductContext(product, options.githubToken, options.fetchFn).catch(
      (err) => {
        console.error('[dispatcher] Failed to fetch product context (continuing without it):', err);
        return undefined;
      },
    );

    // ── Run the remediation (provision → spawn → push). No stage transition. ──
    const result = await runEarlyRemediation({
      kind,
      externalId: item.externalId,
      product,
      prUrl,
      feedback,
      githubToken: options.githubToken,
      runtime,
      context,
      runGit: options?.runGit,
    });

    return {
      specialistId,
      status: result.status,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      prUrl: result.prUrl,
      error: result.error,
    };
  }

  // Stub for future specialists
  return {
    specialistId,
    status: 'error',
    costUsd: 0,
    durationMs: 0,
    error: `Specialist '${specialistId}' is not implemented yet`,
  };
}
