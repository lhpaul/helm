import type { WorkflowStage } from '@helm/workflow';
import { nativeStateTypeForStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { IssueTrackerAdapter } from '@helm/adapters';

/**
 * Native workflow-state writeback precedence (ADR-035 over ADR-034).
 *
 * Mirroring a Helm stage into the tracker's native Status has two strategies:
 *   1. **by id** (ADR-035) — when the product's `workflow.native_state_map`
 *      maps this stage to an exact Linear state id, AND the adapter supports
 *      `setWorkflowStateById`. Lets a team with several states of one type
 *      (e.g. distinct Merged / Released) target a precise column.
 *   2. **by type** (ADR-034) — the default 2-bucket mapping
 *      (`merged`/`released` → completed, else started) via
 *      `setWorkflowStateByType`.
 *
 * This module is the SINGLE place that decides which applies, so the live
 * writeback (`item-service`) and the backfill (`writeback-backfill`) can never
 * drift. Both call `resolveNativeStateWrite` and then run the returned closure
 * inside their own best-effort try/timeout — the precedence lives here, the
 * error/timeout/counter handling stays with each caller.
 */

export type NativeStateWrite = {
  /** Performs the resolved native-state mutation on the adapter. */
  run: (externalId: string) => Promise<void>;
  /**
   * Human-readable target for logs and timeout labels: the native state TYPE
   * for the by-type path (e.g. `started`), or `id:<stateId>` for the override.
   */
  label: string;
};

/**
 * Resolves how `stage` should mirror to the tracker's native Status for
 * `product`, applying the ADR-035 by-id override over the ADR-034 by-type
 * default. Returns `null` when native mirroring does not apply — a non-Linear
 * product, or an adapter that supports neither native-state capability — so the
 * caller skips cleanly (same posture as before: the `helm:*` label is the
 * primary signal; native Status is a Linear-only convenience mirror).
 */
export function resolveNativeStateWrite(
  adapter: IssueTrackerAdapter,
  product: Product,
  stage: WorkflowStage,
): NativeStateWrite | null {
  // Linear-only (consistent with ADR-034): GitHub Projects native Status is a
  // deferred follow-up.
  if (product.issue_tracker.provider !== 'linear') return null;

  // (1) Per-stage by-id override (ADR-035) — only when both the map entry and
  // the adapter capability are present; otherwise fall through to by-type.
  const mappedId = product.workflow?.native_state_map?.[stage];
  if (mappedId && adapter.setWorkflowStateById) {
    return {
      run: (externalId) => adapter.setWorkflowStateById!(externalId, mappedId),
      label: `id:${mappedId}`,
    };
  }

  // (2) By-type default (ADR-034).
  if (adapter.setWorkflowStateByType) {
    const type = nativeStateTypeForStage(stage);
    return {
      run: (externalId) => adapter.setWorkflowStateByType!(externalId, type),
      label: type,
    };
  }

  return null;
}
