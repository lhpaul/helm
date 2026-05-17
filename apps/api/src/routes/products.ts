import { Hono } from 'hono';
import { getProductRegistry, getItemStore } from '../services/index.js';

export const productsRouter = new Hono();

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
  const slug = c.req.param('slug');
  try {
    const products = await getProductRegistry();
    const product = products.find((p) => p.product.slug === slug);
    if (!product) {
      return c.json({ error: `Product not found: ${slug}` }, 404);
    }
    return c.json(product);
  } catch (err) {
    console.error(`[products] Failed to load product ${slug}:`, err);
    return c.json({ error: 'Failed to load product registry' }, 500);
  }
});

// ── GET /api/products/:slug/items ─────────────────────────────────────────────

productsRouter.get('/products/:slug/items', async (c) => {
  const slug = c.req.param('slug');
  try {
    // Verify the product exists before querying items
    const products = await getProductRegistry();
    const product = products.find((p) => p.product.slug === slug);
    if (!product) {
      return c.json({ error: `Product not found: ${slug}` }, 404);
    }

    const store = await getItemStore();
    const allItems = await store.list();
    const items = allItems.filter((item) => item.productSlug === slug);
    return c.json(items);
  } catch (err) {
    console.error(`[products] Failed to load items for ${slug}:`, err);
    return c.json({ error: 'Failed to load items' }, 500);
  }
});
