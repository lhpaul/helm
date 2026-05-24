import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { IAgentRuntime } from './runtime.js';
import type { ItemTransitionFn } from './specialists/spec-writer.js';
import { buildSpecWriterParams, handleSpecWriterResult } from './specialists/spec-writer.js';
import { fetchProductContext } from './specialists/fetch-product-context.js';
import type { FetchFn } from './specialists/fetch-product-context.js';

// ── Stage → specialist mapping ────────────────────────────────────────────────
// Expanded in later sessions (plan-writer, implementer, etc.)

const STAGE_TO_SPECIALIST: Partial<Record<WorkflowStage, string>> = {
  discovery: 'spec-writer',
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
   * Used to locate `knowledge-repos/{productSlug}/` for the publish step.
   * Required for the publish step to run.
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
    const publishOpts =
      options?.githubToken && options?.dataRoot
        ? {
            product,
            knowledgeRepoLocalPath: join(options.dataRoot, 'knowledge-repos', item.productSlug),
            githubToken: options.githubToken,
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

  // Stub for future specialists
  return {
    specialistId,
    status: 'error',
    costUsd: 0,
    durationMs: 0,
    error: `Specialist '${specialistId}' is not implemented yet`,
  };
}
