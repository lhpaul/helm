import { Hono } from 'hono';
import { z } from 'zod';
import { mapErrorToResponse, validateExternalId } from '../lib/http-errors.js';
import { getItemStore, getProductConfig } from '../services/index.js';
import { ItemNotFoundError, StageMismatchError } from '../services/errors.js';

// NOTE: No authentication in v0. This server is self-hosted single-user.
// Authentication and authorization enter in v1+ with multi-tenant support.

export const releaseRouter = new Hono();

// ── Request schema ────────────────────────────────────────────────────────────
//
// `reason` is an optional operator note (mirrors the WorkflowEvent.note shape).
// .strict() rejects unknown keys so a typo'd field fails loudly instead of being
// silently dropped.

const ReleaseBodySchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

// ── Error → HTTP status mapping (ADR-032) ─────────────────────────────────────
// 400 Bad Request:           invalid body, invalid externalId, or item not in
//                            'merged' (StageMismatchError — mirrors the rollback
//                            endpoint's handling of an unexpected current stage)
// 404 Not Found:             item does not exist (ItemNotFoundError)
// 409 Conflict:              product has final_stage=merged (no released stage);
//                            a product-config conflict, distinct from a bad request
// 500 Internal Server Error: product/item store unavailable, unexpected errors

// ── POST /api/items/:externalId/release ───────────────────────────────────────
//
// Operator promote: advances an item from 'merged' to 'released' (shipped to
// users). This is a normal FORWARD edge in the state machine, so it uses
// ItemStore.transition() (NOT forceTransition — that is reserved for the rollback
// escape valve, ADR-029). The bulk counterpart is the release.published webhook.

releaseRouter.post('/items/:externalId/release', async (c) => {
  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const externalId = idResult.value;

  const bodyResult = ReleaseBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  // Opt-out guard: a product whose terminal stage is `merged` has no released
  // stage, so there is nothing to promote to. 409 — a product-config conflict,
  // not a malformed request.
  let config;
  try {
    config = await getProductConfig();
  } catch (err) {
    console.error('[release] Failed to load product config:', err);
    return c.json({ error: 'Failed to load product config' }, 500);
  }
  if (config.workflow.final_stage === 'merged') {
    return c.json(
      { error: "Product has no 'released' stage (workflow.final_stage is 'merged')" },
      409,
    );
  }

  let store;
  try {
    store = await getItemStore();
  } catch (err) {
    console.error('[release] Failed to load item store:', err);
    return c.json({ error: 'Failed to load item store' }, 500);
  }

  try {
    // Pre-check the current stage so an item not in `merged` yields a 400
    // (StageMismatchError → 400), mirroring the rollback endpoint, instead of a
    // 422 from validateTransition. The release trigger is only valid from
    // `merged`; any other stage is an operator precondition failure.
    const item = await store.get(externalId);
    if (item === null) {
      throw new ItemNotFoundError(externalId);
    }
    if (item.currentStage !== 'merged') {
      throw new StageMismatchError(externalId, 'merged', item.currentStage);
    }

    const updated = await store.transition({
      externalId,
      toStage: 'released',
      triggeredBy: 'manual:release',
      note: bodyResult.data.reason,
    });
    // The appended event is always the last history entry on success. Spread-copy
    // so the response never hands out a reference into store-owned state.
    const historyEntry = { ...updated.history[updated.history.length - 1] };
    return c.json({
      externalId: updated.externalId,
      currentStage: updated.currentStage,
      historyEntry,
    });
  } catch (err) {
    // ItemNotFoundError → 404; StageMismatchError → 400 (current stage isn't
    // 'merged' — a client precondition failure). Unexpected errors re-throw to
    // Hono's default handler for a generic 500, consistent with the other routes.
    const mapped = mapErrorToResponse(err);
    if (mapped.status === 500) throw err;
    return c.json(mapped.body, mapped.status);
  }
});
