import type { WorkflowStage } from '@helm/workflow';
import type { IssueTracker, Product } from '@helm/shared';
import type { IssueTrackerAdapter } from '@helm/adapters';
import { getIssueTrackerAdapter, getItemStore, getProductConfig } from './index.js';
import { resolveNativeStateWrite } from './native-state-writeback.js';
import { TRACKER_WRITE_TIMEOUT_MS, withTimeout } from '../lib/with-timeout.js';
import type { ItemState } from './types.js';

/**
 * Transition + tracker-writeback service (ADR-033).
 *
 * Helm's `ItemStore` is deliberately pure-local (ADR-029): it persists stage to
 * disk and imports no adapter. That keeps it trivially testable, but it also
 * means the external tracker (Linear label / GitHub Projects single-select)
 * never learns that an item advanced — visible during the AF pilot, where every
 * LEA item showed stale despite the store advancing correctly.
 *
 * This module is the thin seam that fixes that: each stage-mutating wrapper
 * applies the store change first (store stays the source of truth), then writes
 * the new stage back to the tracker through the single `writebackStage` choke
 * point. Writeback is best-effort — a tracker API hiccup is logged and the
 * workflow continues, mirroring how the webhook handlers already swallow
 * external errors.
 *
 * Call sites that mutate stage (routes/items, routes/dispatch, routes/webhooks,
 * routes/release, routes/rollback) go through these wrappers instead of calling
 * the store directly, so writeback can never be silently forgotten on a new
 * route.
 */

/**
 * Anti-echo guard.
 *
 * Helm already consumes a tracker→store webhook: a human moving the Linear label
 * / GitHub Projects option fires `item_updated`, which transitions the store.
 * If writeback fired on *every* transition, that tracker-originated change would
 * loop: tracker → webhook → store transition → writeback → tracker → …
 *
 * So we skip writeback only for transitions that originated in the issue tracker
 * (the tracker already has the new stage). Every other trigger — `webhook:code-repo`,
 * `webhook:knowledge-repo`, `webhook:release`, `manual:*`, `agent:*` — originates
 * outside the tracker, so the tracker does NOT know yet and we DO write back.
 *
 * Prefix match (not exact equality) is intentional: it is forward-compatible with
 * a future sub-typed tracker trigger (e.g. `webhook:github-projects:item_updated`)
 * without reopening the echo. It is safe today because no non-tracker trigger
 * shares either prefix, so there are no false anti-echo matches.
 */
function isTrackerOriginated(triggeredBy: string): boolean {
  return (
    triggeredBy.startsWith('webhook:github-projects') || triggeredBy.startsWith('webhook:linear')
  );
}

/**
 * Memoizes `ensureSubStages` per adapter instance.
 *
 * `setSubStage` requires the stage map (Linear `helm:*` labels / GitHub Projects
 * single-select options) to exist. Linear's `setSubStage` self-heals if a label
 * is missing, but GitHub's throws ("call ensureSubStages first"), so we must run
 * `ensureSubStages` at least once before the first writeback.
 *
 * Neither adapter no-ops a repeat `ensureSubStages` cheaply — both re-fetch
 * labels/fields over the network every call — so calling it on every transition
 * would be a per-transition network storm. We therefore run it exactly once per
 * adapter instance. The map is keyed on the adapter object (a process singleton
 * from `getIssueTrackerAdapter`), so when `_resetForTests` swaps the singleton
 * the memo resets automatically with no separate reset hook. A failed ensure is
 * evicted so a later transition can retry.
 */
const ensureSubStagesMemo = new WeakMap<IssueTrackerAdapter, Promise<void>>();

function ensureSubStagesOnce(adapter: IssueTrackerAdapter, config: IssueTracker): Promise<void> {
  let pending = ensureSubStagesMemo.get(adapter);
  if (!pending) {
    pending = adapter.ensureSubStages(config);
    ensureSubStagesMemo.set(adapter, pending);
    // Evict on failure so the next writeback retries instead of caching a reject.
    pending.catch(() => {
      if (ensureSubStagesMemo.get(adapter) === pending) ensureSubStagesMemo.delete(adapter);
    });
  }
  return pending;
}

/**
 * The single writeback choke point: pushes `stage` to the tracker for `externalId`.
 *
 * Best-effort by contract — never throws. Anti-echo short-circuits
 * tracker-originated transitions. The store remains the source of truth, so a
 * writeback failure (auth, network, missing item) is logged and swallowed.
 *
 * Two INDEPENDENT best-effort writes happen here (ADR-033 + ADR-034):
 *   1. the `helm:*` sub-stage label (primary signal, all providers), and
 *   2. the native workflow Status (secondary, Linear-only).
 * Each has its own try/timeout so a failure in one cannot block the other — the
 * label is the primary signal; the native state is a convenience mirror.
 */
async function writebackStage(
  externalId: string,
  stage: WorkflowStage,
  triggeredBy: string,
): Promise<void> {
  // Anti-echo: the tracker already has this change.
  if (isTrackerOriginated(triggeredBy)) return;

  let adapter: IssueTrackerAdapter;
  let product: Product;
  try {
    [adapter, product] = await Promise.all([getIssueTrackerAdapter(), getProductConfig()]);
  } catch (err) {
    // Adapter/config resolution failed (e.g. missing token) — nothing to write.
    console.error(`[writeback] failed for ${externalId}→${stage}:`, err);
    return;
  }

  // (1) Sub-stage label — primary signal, all providers.
  try {
    // Bound the tracker network calls so a stalled connection can't hang the
    // request path (the route awaits this). On timeout the race rejects and the
    // catch below logs + continues — the store is already the source of truth.
    await withTimeout(
      (async () => {
        // Ensure the stage map exists once (memoized) before setting the label.
        await ensureSubStagesOnce(adapter, product.issue_tracker);
        await adapter.setSubStage(externalId, stage);
      })(),
      TRACKER_WRITE_TIMEOUT_MS,
      `writeback ${externalId}→${stage}`,
    );
  } catch (err) {
    console.error(`[writeback] failed for ${externalId}→${stage}:`, err);
  }

  // (2) Native workflow Status — secondary, Linear-only, independent.
  await writebackNativeState(adapter, product, externalId, stage);
}

/**
 * Mirrors the stage into the tracker's NATIVE workflow Status (ADR-034 by-type,
 * with the ADR-035 per-product by-id override).
 *
 * Independent best-effort: the precedence (mapped id vs by-type default) is
 * resolved once in `resolveNativeStateWrite`, which returns `null` for a
 * non-Linear product or a capability-less adapter so this skips cleanly. A
 * failure here is logged and swallowed — it must never affect the label write
 * or the route, since the `helm:*` label is the primary signal and the native
 * state only a convenience mirror.
 */
async function writebackNativeState(
  adapter: IssueTrackerAdapter,
  product: Product,
  externalId: string,
  stage: WorkflowStage,
): Promise<void> {
  const write = resolveNativeStateWrite(adapter, product, stage);
  if (!write) return;

  try {
    await withTimeout(
      write.run(externalId),
      TRACKER_WRITE_TIMEOUT_MS,
      `writeback-native ${externalId}→${write.label}`,
    );
  } catch (err) {
    console.error(`[writeback] native state failed for ${externalId}→${write.label}:`, err);
  }
}

// ── Public wrappers ───────────────────────────────────────────────────────────

/**
 * Advances an item via the validated state machine, then writes the new stage
 * back to the tracker (best-effort). Drop-in replacement for `store.transition`.
 */
export async function transitionItem(input: {
  externalId: string;
  toStage: WorkflowStage;
  triggeredBy: string;
  note?: string;
}): Promise<ItemState> {
  const store = await getItemStore();
  const updated = await store.transition(input);
  await writebackStage(updated.externalId, updated.currentStage, input.triggeredBy);
  // Defensive copy: callers own the result, not the store-built object.
  return { ...updated, history: [...updated.history] };
}

/**
 * Compare-and-set variant for event reconciliation. The store writes only when
 * the item is still at `fromStage`, and persisted history carries the optional
 * idempotency key. Successful transitions use the same tracker writeback path
 * as normal transitionItem().
 */
export async function transitionItemIfCurrentStage(input: {
  externalId: string;
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  triggeredBy: string;
  note?: string;
  idempotencyKey?: string;
}): Promise<ItemState> {
  const result = await transitionItemIfCurrentStageResult(input);
  return result.item;
}

export async function transitionItemIfCurrentStageResult(input: {
  externalId: string;
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  triggeredBy: string;
  note?: string;
  idempotencyKey?: string;
}): Promise<{ item: ItemState; applied: boolean }> {
  const store = await getItemStore();
  const { state: updated, applied } = await store.transitionIfCurrentStage(input);
  if (applied) {
    await writebackStage(updated.externalId, updated.currentStage, input.triggeredBy);
  }
  return { item: { ...updated, history: [...updated.history] }, applied };
}

/**
 * Force-advances an item bypassing the state machine (operator escape valve,
 * ADR-029), then writes the new stage back to the tracker (best-effort).
 * Drop-in replacement for `store.forceTransition`.
 */
export async function forceTransitionItem(input: {
  externalId: string;
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  triggeredBy: string;
  note?: string;
}): Promise<ItemState> {
  const store = await getItemStore();
  const updated = await store.forceTransition(input);
  await writebackStage(updated.externalId, updated.currentStage, input.triggeredBy);
  // Defensive copy: callers own the result, not the store-built object.
  return { ...updated, history: [...updated.history] };
}

/**
 * Creates an item at INITIAL_STAGE, then writes the initial stage label back to
 * the tracker (best-effort). Drop-in replacement for `store.create`.
 *
 * Note: a tracker-originated create (`webhook:github-projects` / `webhook:linear`)
 * is anti-echo-skipped — the item already exists in the tracker; Helm does not
 * stamp a label onto a human-created issue. API/manual creates DO write the
 * initial label.
 */
export async function createItem(input: {
  externalId: string;
  productSlug: string;
  triggeredBy: string;
}): Promise<ItemState> {
  const store = await getItemStore();
  const created = await store.create(input);
  await writebackStage(created.externalId, created.currentStage, input.triggeredBy);
  // Defensive copy: callers own the result, not the store-built object.
  return { ...created, history: [...created.history] };
}
