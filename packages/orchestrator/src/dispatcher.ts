import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { IAgentRuntime } from './runtime.js';
import type { ItemTransitionFn } from './specialists/spec-writer.js';
import { buildSpecWriterParams, handleSpecWriterResult } from './specialists/spec-writer.js';
import { buildPlanWriterParams, handlePlanWriterResult } from './specialists/plan-writer.js';
import type { PlanPublishOptions } from './specialists/plan-writer.js';
import { fetchProductContext, fetchSpecForPlan } from './specialists/fetch-product-context.js';
import type { FetchFn } from './specialists/fetch-product-context.js';
import type { RunGit, RunGh } from './specialists/spec-publisher.js';

// ── Stage → specialist mapping ────────────────────────────────────────────────

const STAGE_TO_SPECIALIST: Partial<Record<WorkflowStage, string>> = {
  discovery: 'spec-writer',
  'spec-ready': 'plan-writer',
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
};

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

    const params = buildSpecWriterParams(item.externalId, product, workdir, context);
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
      status: agentResult.status,
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
      status: agentResult.status,
      newStage: planResult.newStage,
      costUsd: agentResult.totalCostUsd,
      durationMs: agentResult.durationMs,
      prUrl: planResult.prUrl,
      error: planResult.error,
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
