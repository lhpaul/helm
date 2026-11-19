import { Hono } from 'hono';
import { HELM_VERSION } from '@helm/shared';
import { apiAuth, resolveApiAuth } from './lib/api-auth.js';
import { originGuard, resolveAllowedOrigins } from './lib/origin-guard.js';
import { dispatchRouter } from './routes/dispatch.js';
import { itemsRouter } from './routes/items.js';
import { jobsRouter } from './routes/jobs.js';
import { productRouter } from './routes/product.js';
import { productsRouter } from './routes/products.js';
import { releaseRouter } from './routes/release.js';
import { rollbackRouter } from './routes/rollback.js';
import { usageRouter } from './routes/usage.js';
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

// Reject cross-origin browser requests to state-changing routes (#162).
// Registered before the routers so it runs first for every /api/* request.
const allowedOrigins = resolveAllowedOrigins(process.env);
for (const warning of allowedOrigins.warnings) console.warn(warning);
app.use('/api/*', originGuard(allowedOrigins.origins));

// Operator token on every /api/* route except the signed webhooks (#160,
// ADR-045). Runs after the origin guard and before the routers. index.ts
// reuses the same instance on the /ws upgrade.
const apiAuthConfig = resolveApiAuth(process.env);
for (const error of apiAuthConfig.errors) console.error(error);
for (const warning of apiAuthConfig.warnings) console.warn(warning);
export const apiAuthMiddleware = apiAuth(apiAuthConfig);
app.use('/api/*', apiAuthMiddleware);

app.route('/api', productRouter);
app.route('/api', productsRouter);
app.route('/api', itemsRouter);
app.route('/api', rollbackRouter);
app.route('/api', releaseRouter);
app.route('/api', webhooksRouter);
app.route('/api', dispatchRouter);
app.route('/api', jobsRouter);
app.route('/api', usageRouter);
