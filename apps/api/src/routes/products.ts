import { Hono } from 'hono';
import { z } from 'zod';
import { getProductRegistry, getItemStore } from '../services/index.js';

export const productsRouter = new Hono();

// Slug format mirrors product.schema.ts: lowercase alphanumeric + hyphens.
const SlugParamsSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Invalid product slug format'),
  })
  .strict();

function parseSlug(raw: string): string | null {
  const result = SlugParamsSchema.safeParse({ slug: raw });
  return result.success ? result.data.slug : null;
}

// ── GET /api/products ─────────────────────────────────────────────────────────

productsRouter.get('/products', async (c) => {
  try {
    const products = await getProductRegistry();
    return c.json(products);
  } catch (err) {
    console.error('[products] Failed to load product registry:', err);
    return c.json({ error: 'Failed to load product registry' }, 500);
  }
});

// ── GET /api/products/:slug ───────────────────────────────────────────────────

productsRouter.get('/products/:slug', async (c) => {
  const slug = parseSlug(c.req.param('slug'));
  if (!slug) return c.json({ error: 'Invalid product slug' }, 400);

  try {
    const products = await getProductRegistry();
    const product = products.find((p) => p.product.slug === slug);
    if (!product) return c.json({ error: `Product not found: ${slug}` }, 404);
    return c.json(product);
  } catch (err) {
    console.error(`[products] Failed to load product ${slug}:`, err);
    return c.json({ error: 'Failed to load product registry' }, 500);
  }
});

// ── GET /api/products/:slug/items ─────────────────────────────────────────────

productsRouter.get('/products/:slug/items', async (c) => {
  const slug = parseSlug(c.req.param('slug'));
  if (!slug) return c.json({ error: 'Invalid product slug' }, 400);

  try {
    const products = await getProductRegistry();
    const product = products.find((p) => p.product.slug === slug);
    if (!product) return c.json({ error: `Product not found: ${slug}` }, 404);

    const store = await getItemStore();
    const allItems = await store.list();
    const items = allItems.filter((item) => item.productSlug === slug);
    return c.json(items);
  } catch (err) {
    console.error(`[products] Failed to load items for ${slug}:`, err);
    return c.json({ error: 'Failed to load items' }, 500);
  }
});
