import { Hono } from 'hono';
import { join } from 'node:path';
import { z } from 'zod';
import { dispatchStageHandler } from '@helm/orchestrator';
import { getProductRegistry, getItemStore } from '../services/index.js';
import { createRuntimeForProduct } from '../services/runtime-factory.js';
import { ItemNotFoundError } from '../services/errors.js';
import { EXTERNAL_ID_REGEX } from '../services/types.js';

export const dispatchRouter = new Hono();

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/);
const BodySchema = z.object({ specialistId: z.string().min(1).optional() }).strict();

dispatchRouter.post('/products/:slug/items/:externalId/dispatch', async (c) => {
  const slug = c.req.param('slug');
  const externalId = c.req.param('externalId');

  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }
  // Defense-in-depth: EXTERNAL_ID_REGEX already blocks leading dots (via the
  // (?!\.) lookahead), so '.' and '..' fail the regex too. The explicit check
  // below makes the intent clear and guards against future regex relaxations.
  if (!EXTERNAL_ID_REGEX.test(externalId) || externalId === '.' || externalId === '..') {
    return c.json({ error: `Invalid externalId: "${externalId}"` }, 400);
  }

  // Parse JSON body explicitly so malformed JSON returns 400 instead of
  // being silently swallowed as an empty object.
  let parsedBody: unknown = {};
  const rawBody = await c.req.text();
  if (rawBody.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
  }
  const bodyResult = BodySchema.safeParse(parsedBody);
  if (!bodyResult.success) {
    console.error('[dispatch] Invalid request body:', bodyResult.error.issues);
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Resolve product
  let product;
  try {
    const products = await getProductRegistry();
    product = products.find((p) => p.product.slug === slug);
    if (!product) return c.json({ error: `Product not found: ${slug}` }, 404);
  } catch (err) {
    console.error('[dispatch] Failed to load product registry:', err);
    return c.json({ error: 'Failed to load product registry' }, 500);
  }

  // Resolve item
  let store;
  let item;
  try {
    store = await getItemStore();
    item = await store.get(externalId);
  } catch (err) {
    console.error('[dispatch] Failed to load item:', err);
    return c.json({ error: 'Failed to load item' }, 500);
  }
  // Also reject when the item belongs to a different product than the URL slug.
  if (!item || item.productSlug !== slug) {
    return c.json({ error: `Item not found: ${externalId}` }, 404);
  }

  // Determine workdir — sibling of the data/items directory
  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  const dataRoot = envDataDir || join(process.cwd(), 'data');
  const workdir = join(dataRoot, 'worktrees', slug, externalId);

  // Select runtime based on product specialist config.
  // 'claude_code' → ClaudeCodeRuntime (real). Tests inject a mock via vi.mock
  // on '../services/runtime-factory.js'. See runtime-factory.ts for details.
  const runtime = createRuntimeForProduct(product, externalId, workdir);

  try {
    const result = await dispatchStageHandler(
      { externalId, productSlug: item.productSlug, currentStage: item.currentStage },
      product,
      runtime,
      (input) => store.transition(input),
      { workdir, specialistId: bodyResult.data.specialistId },
    );

    if (result.status === 'error') {
      if (result.error?.includes('No specialist mapped')) {
        return c.json({ error: 'Unsupported stage for dispatch' }, 400);
      }
      console.error('[dispatch] Dispatch failed:', result.error);
      return c.json({ error: 'Dispatch failed' }, 500);
    }

    return c.json(result, 200);
  } catch (err) {
    if (err instanceof ItemNotFoundError) {
      return c.json({ error: `Item not found: ${err.externalId}` }, 404);
    }
    console.error('[dispatch] Unexpected error:', err);
    return c.json({ error: 'Dispatch failed' }, 500);
  }
});
