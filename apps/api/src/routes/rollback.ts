import { Hono } from 'hono';
import { z } from 'zod';
import { mapErrorToResponse, validateExternalId } from '../lib/http-errors.js';
import { getJobStore, getProductConfig } from '../services/index.js';
import { forceTransitionItem } from '../services/item-service.js';

// NOTE: No authentication in v0. This server is self-hosted single-user.
// Authentication and authorization enter in v1+ with multi-tenant support.

export const rollbackRouter = new Hono();

// ── Request schema ────────────────────────────────────────────────────────────
//
// The allow-list is enforced at the schema boundary via strict literals: the
// ONLY permitted rollback pair is in-development → plan-ready (ADR-029). Any
// future pair (e.g. code-review → plan-ready) requires an intentional schema
// change, which forces deliberate review. `reason` is required here even though
// WorkflowEvent.note is optional in the shared type — the rollback contract is
// strict from the API side without tightening the shared type for other flows.

const RollbackBodySchema = z
  .object({
    fromStage: z.literal('in-development'),
    toStage: z.literal('plan-ready'),
    reason: z.string().min(1).max(500),
  })
  .strict();

// ── Error → HTTP status mapping ───────────────────────────────────────────────
// 400 Bad Request:           invalid body, invalid externalId, or current stage
//                            does not match `fromStage` (StageMismatchError)
// 404 Not Found:             item does not exist (ItemNotFoundError)
// 409 Conflict:              a dispatch job is currently running for this item
// 500 Internal Server Error: product/job store unavailable, unexpected errors

// ── POST /api/items/:externalId/rollback ──────────────────────────────────────
//
// Operator escape valve: returns an item from 'in-development' to 'plan-ready'
// after a failed implementer dispatch (Codex CLI crash, image-tool defect,
// environmental wedge). Bypasses the state machine's VALID_TRANSITIONS via
// ItemStore.forceTransition; the state machine itself stays untouched. See
// ADR-029. The previous workaround (hand-editing the item JSON, documented in
// the AF driver gotchas table) is now obsolete.

rollbackRouter.post('/items/:externalId/rollback', async (c) => {
  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const externalId = idResult.value;

  const bodyResult = RollbackBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  // productSlug comes from the loaded Product config (single-product v0), mirroring
  // itemsRouter — the job lookup is scoped by slug + externalId.
  let productSlug: string;
  try {
    const config = await getProductConfig();
    productSlug = config.product.slug;
  } catch (err) {
    console.error('[rollback] Failed to load product config:', err);
    return c.json({ error: 'Failed to load product config' }, 500);
  }

  // Concurrency guard: refuse to move the item while a dispatch is in flight.
  // A rollback during an active job would race the job's own transition writes.
  //
  // Residual race (acceptable for the v0 single-process / single-user scope, in
  // line with the "last write wins" note on ItemStore.transition): this is a
  // read-only check against jobs already persisted to disk. It does NOT consult
  // JobStore's in-memory inflight set, so a dispatch that is mid-creation (lock
  // held in createJobIfNoRunning, job file not yet written) is invisible here;
  // and no lock spans the gap between this check and forceTransition, so a
  // dispatch starting immediately after is unguarded. This is a best-effort
  // guard, not a hard mutex. Promote to a shared lock alongside the item-store
  // concurrency work (ItemStore.transition's noted v0 limitation) if parallel
  // dispatch + rollback becomes real.
  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[rollback] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }
  const runningJob = await jobStore.getRunningJobForItem(productSlug, externalId);
  if (runningJob) {
    return c.json(
      {
        error: 'A dispatch job is currently running for this item',
        runningJobId: runningJob.jobId,
      },
      409,
    );
  }

  try {
    // forceTransitionItem wraps store.forceTransition with best-effort tracker
    // writeback (ADR-033). manual:rollback is not tracker-originated → the
    // rolled-back stage (plan-ready) is mirrored to the tracker.
    const item = await forceTransitionItem({
      externalId,
      fromStage: bodyResult.data.fromStage,
      toStage: bodyResult.data.toStage,
      triggeredBy: 'manual:rollback',
      note: bodyResult.data.reason,
    });
    // The appended event is always the last history entry on success.
    const historyEntry = item.history[item.history.length - 1];
    return c.json({ externalId: item.externalId, currentStage: item.currentStage, historyEntry });
  } catch (err) {
    // ItemNotFoundError → 404; StageMismatchError → 400 (current stage doesn't
    // match fromStage — a client precondition failure, not a server error).
    // Unexpected errors re-throw to Hono's default handler for a generic 500,
    // consistent with itemsRouter / dispatchRouter.
    const mapped = mapErrorToResponse(err);
    if (mapped.status === 500) throw err;
    return c.json(mapped.body, mapped.status);
  }
});
