import { Hono } from 'hono';
import { z } from 'zod';
import { WORKFLOW_STAGES, WorkflowTransitionError } from '@helm/workflow';
import { ItemAlreadyExistsError, ItemNotFoundError } from '../services/errors.js';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import { getItemStore, getProductConfig } from '../services/index.js';

// NOTE: No authentication in v0. This server is self-hosted single-user.
// Authentication and authorization enter in v1+ with multi-tenant support.

export const itemsRouter = new Hono();

// ── Request schemas ───────────────────────────────────────────────────────────

const CreateItemBodySchema = z
  .object({
    externalId: z.string().regex(EXTERNAL_ID_REGEX, 'Invalid externalId format'),
    triggeredBy: z.string().min(1),
  })
  .strict();

const TransitionBodySchema = z
  .object({
    toStage: z.enum(WORKFLOW_STAGES),
    triggeredBy: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

// ── Error → HTTP status mapping ───────────────────────────────────────────────
// 400 Bad Request:          Zod validation failure, invalid externalId path param
// 404 Not Found:            ItemNotFoundError
// 409 Conflict:             ItemAlreadyExistsError
// 422 Unprocessable Entity: WorkflowTransitionError (item exists + inputs valid,
//                           but the specific transition is not permitted right now)
// 500 Internal Server Error: product config unavailable, unexpected errors

// ── POST /api/items ───────────────────────────────────────────────────────────

itemsRouter.post('/items', async (c) => {
  const bodyResult = CreateItemBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  // productSlug comes from the loaded Product config — NOT from the request body.
  // Callers cannot create items with arbitrary product slugs.
  let productSlug: string;
  try {
    const config = await getProductConfig();
    productSlug = config.product.slug;
  } catch (err) {
    // Log full error server-side for operator diagnostics; return a generic
    // message to the client to avoid leaking filesystem paths or config details.
    console.error('[items] Failed to load product config:', err);
    return c.json({ error: 'Failed to load product config' }, 500);
  }

  const store = await getItemStore();
  try {
    const item = await store.create({
      externalId: bodyResult.data.externalId,
      productSlug,
      triggeredBy: bodyResult.data.triggeredBy,
    });
    return c.json(item, 201);
  } catch (err) {
    if (err instanceof ItemAlreadyExistsError) {
      return c.json({ error: `Item already exists: ${err.externalId}` }, 409);
    }
    throw err;
  }
});

// ── GET /api/items ────────────────────────────────────────────────────────────

itemsRouter.get('/items', async (c) => {
  const store = await getItemStore();
  const items = await store.list();
  return c.json(items);
});

// ── POST /api/items/:externalId/transitions ───────────────────────────────────

itemsRouter.post('/items/:externalId/transitions', async (c) => {
  const externalId = c.req.param('externalId');
  if (!EXTERNAL_ID_REGEX.test(externalId)) {
    return c.json({ error: `Invalid externalId: "${externalId}"` }, 400);
  }

  const bodyResult = TransitionBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  const store = await getItemStore();
  try {
    const item = await store.transition({
      externalId,
      toStage: bodyResult.data.toStage,
      triggeredBy: bodyResult.data.triggeredBy,
      note: bodyResult.data.note,
    });
    return c.json(item);
  } catch (err) {
    if (err instanceof ItemNotFoundError) {
      return c.json({ error: `Item not found: ${err.externalId}` }, 404);
    }
    if (err instanceof WorkflowTransitionError) {
      return c.json({ error: err.message }, 422);
    }
    throw err;
  }
});
