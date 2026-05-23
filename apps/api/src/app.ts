import { Hono } from 'hono';
import { HELM_VERSION } from '@helm/shared';
import { dispatchRouter } from './routes/dispatch.js';
import { itemsRouter } from './routes/items.js';
import { jobsRouter } from './routes/jobs.js';
import { productRouter } from './routes/product.js';
import { productsRouter } from './routes/products.js';
import { webhooksRouter } from './routes/webhooks.js';

export const app = new Hono();

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    version: HELM_VERSION,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  }),
);

app.route('/api', productRouter);
app.route('/api', productsRouter);
app.route('/api', itemsRouter);
app.route('/api', webhooksRouter);
app.route('/api', dispatchRouter);
app.route('/api', jobsRouter);
