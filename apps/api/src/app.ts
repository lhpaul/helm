import { Hono } from 'hono';
import { HELM_VERSION } from '@helm/shared';
import { productRouter } from './routes/product.js';

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
