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
  runCodeReviewLoop,
  runEarlyArtifactReviewLoop,
  type DeferredExternalReviewIntent,
} from './review-loop/code-review-loop.js';
import { resolveReviewLoopConfig } from './review-loop/config.js';
import type { RunExternalReviewDeps } from './external-review/run.js';
import type { StopRuleEscalationReason } from './review-loop/stop-rule.js';
import type { StoredResolvedProductDecision } from './review-loop/adjudication.js';
import { provisionCodeWorkspace, artifactsDirFor } from './specialists/code-workspace.js';
import {
  fetchProductContext,
  materializeProductContext,
  fetchSpecForPlan,
  fetchPlanForImplementer,
} from './specialists/fetch-product-context.js';
import type { FetchFn } from './specialists/fetch-product-context.js';
import type { RunGit, RunGh } from './specialists/spec-publisher.js';
import { findCodePRUrl, findArtifactPRUrl } from './specialists/pr-helpers.js';
import { runEarlyRemediation, type EarlyRemediatorKind } from './specialists/early-remediator.js';

// ── Stage → specialist mapping ────────────────────────────────────────────────

const STAGE_TO_SPECIALIST: Partial<Record<WorkflowStage, string>> = {
  discovery: 'spec-writer',
  'spec-ready': 'plan-writer',
  'plan-ready': 'implementer',
  'code-review': 'reviewer-fanout',
};

/**
 * Resolves the specialist a dispatch would run: an explicit override wins,
 * otherwise the stage-driven default. Returns undefined when no specialist maps
 * to the stage. Exported so the API readiness gate can decide whether a dispatch
 * would run the spec-writer without duplicating STAGE_TO_SPECIALIST.
 */
export function resolveSpecialistId(
  currentStage: WorkflowStage,
  explicitSpecialistId?: string,
): string | undefined {
  return explicitSpecialistId ?? STAGE_TO_SPECIALIST[currentStage];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DispatchInput = {
  externalId: string;
  productSlug: string;
  currentStage: WorkflowStage;
};

export type DispatchResult = {
  specialistId: string;
  status: 'done' | 'error' | 'cancelled' | 'deferred';
  newStage?: WorkflowStage;
  costUsd: number;
  durationMs: number;
  /** URL of the knowledge-repo PR opened by the publish step, if applicable. */
  prUrl?: string;
  error?: string;
  /** ADR-036 review loop — set when code-review dispatch runs the bounded loop. */
  escalated?: boolean;
  escalationReason?: StopRuleEscalationReason;
  cyclesCompleted?: number;
  deferredExternalReview?: DeferredExternalReviewIntent;
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
  /**
   * Persisted human choices for previously escalated product decisions. Used by
   * review loops to avoid reopening the same settled conflict.
   */
  resolvedProductDecisions?: StoredResolvedProductDecision[];
  /**
   * Optional live loader for the settled-decision ledger. Prefer this over the
   * static snapshot when a review job may span multiple cycles.
   */
  loadResolvedProductDecisions?: () => Promise<StoredResolvedProductDecision[]>;
  targetRevision?: string;
  onExternalReviewDeferred?: (intent: DeferredExternalReviewIntent) => Promise<void> | void;
  externalReviewDeps?: RunExternalReviewDeps;
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

  let specialistId = resolveSpecialistId(item.currentStage, options?.specialistId);
  const earlyArtifactKind =
    item.currentStage === 'spec-draft'
      ? 'spec'
      : item.currentStage === 'plan-draft'
        ? 'plan'
        : undefined;
  if (!specialistId && earlyArtifactKind && resolveReviewLoopConfig(product).earlyLoopEnabled) {
    specialistId = `${earlyArtifactKind}-draft-reviewer`;
  }

  if (!specialistId) {
    return {
      specialistId: 'none',
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: `No specialist mapped for stage '${item.currentStage}'`,
    };
  }
  const draftReviewerStage =
    specialistId === 'spec-draft-reviewer'
      ? 'spec-draft'
      : specialistId === 'plan-draft-reviewer'
        ? 'plan-draft'
        : undefined;
  if (
    draftReviewerStage &&
    (resolveReviewLoopConfig(product).earlyLoopEnabled !== true ||
      item.currentStage !== draftReviewerStage)
  ) {
    return {
      specialistId,
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: `${specialistId} requires review.early_loop.enabled=true and stage '${draftReviewerStage}'`,
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

    // ── Part A3: Materialize product context into the worktree (ADR-030) ──────
    // Writes the full README + winning agent instruction file to `workdir` so the
    // agent can cat/grep them on disk (the prompt section stays truncated).
    // Best-effort and token-gated, mirroring Part A: a failure leaves the
    // worktree empty but never fails the dispatch.
    if (options?.githubToken) {
      await materializeProductContext(workdir, product, options.githubToken, options.fetchFn).catch(
        (err) => {
          console.error(
            '[dispatcher] Failed to materialize product context into worktree (continuing):',
            err,
          );
        },
      );
    }

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

    // ── Materialize product context into the worktree (ADR-030) ──────────────
    // Token is guaranteed here (asserted above), so this runs unconditionally —
    // still best-effort: a failure leaves the worktree empty but never fails the
    // dispatch, matching the prompt-injection context fetch above.
    await materializeProductContext(workdir, product, options.githubToken, options.fetchFn).catch(
      (err) => {
        console.error(
          '[dispatcher] Failed to materialize product context into worktree (continuing):',
          err,
        );
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

    // Bounded fanout ↔ remediate loop (ADR-036), then optional external review.
    const loopResult = await runCodeReviewLoop({
      externalId: item.externalId,
      product,
      prUrl,
      codeRepo,
      githubToken: options.githubToken,
      runtime,
      transition,
      runGit: options.runGit,
      runGh: options.runGh,
      fetchFn: options.fetchFn,
      resolvedProductDecisions: options.resolvedProductDecisions,
      loadResolvedProductDecisions: options.loadResolvedProductDecisions,
      targetRevision: options.targetRevision,
      onExternalReviewDeferred: options.onExternalReviewDeferred,
      externalReviewDeps: options.externalReviewDeps,
    });

    return {
      specialistId,
      status: loopResult.status,
      newStage: loopResult.newStage,
      costUsd: loopResult.costUsd,
      durationMs: loopResult.durationMs,
      prUrl: loopResult.prUrl,
      error: loopResult.error,
      escalated: loopResult.escalated,
      escalationReason: loopResult.escalationReason,
      cyclesCompleted: loopResult.cyclesCompleted,
      deferredExternalReview: loopResult.deferredExternalReview,
    };
  }

  if (specialistId === 'spec-draft-reviewer' || specialistId === 'plan-draft-reviewer') {
    const kind = specialistId === 'spec-draft-reviewer' ? 'spec' : 'plan';

    if (!options?.githubToken) {
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `${specialistId} requires GITHUB_TOKEN`,
      };
    }

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
      console.error(
        `[dispatcher] Failed to find ${kind} PR for ${item.externalId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return {
        specialistId,
        status: 'error',
        costUsd: 0,
        durationMs: 0,
        error: `Failed to find ${kind} PR`,
      };
    }

    const loopResult = await runEarlyArtifactReviewLoop({
      kind,
      externalId: item.externalId,
      product,
      prUrl,
      githubToken: options.githubToken,
      runtime,
      transition,
      runGit: options.runGit,
      runGh: options.runGh,
      fetchFn: options.fetchFn,
      resolvedProductDecisions: options.resolvedProductDecisions,
      loadResolvedProductDecisions: options.loadResolvedProductDecisions,
      targetRevision: options.targetRevision,
      onExternalReviewDeferred: options.onExternalReviewDeferred,
      externalReviewDeps: options.externalReviewDeps,
    });

    return {
      specialistId,
      status: loopResult.status,
      newStage: loopResult.newStage,
      costUsd: loopResult.costUsd,
      durationMs: loopResult.durationMs,
      prUrl: loopResult.prUrl,
      error: loopResult.error,
      escalated: loopResult.escalated,
      escalationReason: loopResult.escalationReason,
      cyclesCompleted: loopResult.cyclesCompleted,
      deferredExternalReview: loopResult.deferredExternalReview,
    };
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
