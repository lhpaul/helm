import { Hono } from 'hono';
import { join } from 'node:path';
import { ProductConfigError, parseProductConfigFromFile } from '@helm/shared';
import { publicProductResponse } from './product-response.js';

export const productRouter = new Hono();

productRouter.get('/product', async (c) => {
  const knowledgePath = process.env.HELM_KNOWLEDGE_REPO_PATH;

  if (!knowledgePath) {
    return c.json({ error: 'HELM_KNOWLEDGE_REPO_PATH environment variable not set' }, 500);
  }

  const configPath = join(knowledgePath, '.helm', 'product.yaml');

  try {
    const product = await parseProductConfigFromFile(configPath);
    return c.json(publicProductResponse(product));
  } catch (err) {
    // File not found — check err.code directly (preserved by parseProductConfigFromFile)
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      // Log the absolute path server-side for operational debugging; return only the
      // relative location to the client to avoid leaking host filesystem structure.
      console.error(`[product] config file not found: ${configPath}`);
      return c.json(
        {
          error:
            'product.yaml not found at expected location: $HELM_KNOWLEDGE_REPO_PATH/.helm/product.yaml',
        },
        404,
      );
    }
    // Validation, YAML parse, or non-ENOENT read errors may include local paths.
    // Keep those details server-side and return a stable client-facing error.
    if (err instanceof ProductConfigError) {
      console.error('[product] Failed to load product config:', err);
      return c.json({ error: 'Failed to load product config' }, 500);
    }
    // Unexpected error — let Hono handle it as 500
    throw err;
  }
});
