import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { IAgentRuntime } from './runtime.js';
import type { ItemTransitionFn } from './specialists/spec-writer.js';
import { buildSpecWriterParams, handleSpecWriterResult } from './specialists/spec-writer.js';

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
  error?: string;
};

export type DispatchOptions = {
  /** Absolute path to the working directory for this run. Auto-created if absent. */
  workdir?: string;
  /** Override the specialist determined by stage mapping. */
  specialistId?: string;
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
    const params = buildSpecWriterParams(item.externalId, product, workdir);
    const session = await runtime.spawn(params);
    const agentResult = await session.wait();

    const specResult = await handleSpecWriterResult(
      item.externalId,
      agentResult,
      workdir,
      transition,
    );

    return {
      specialistId,
      status: agentResult.status,
      newStage: specResult.newStage,
      costUsd: agentResult.totalCostUsd,
      durationMs: agentResult.durationMs,
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
