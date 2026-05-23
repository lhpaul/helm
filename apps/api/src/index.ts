import { createBunWebSocket } from 'hono/bun';
import { app } from './app.js';
import { getJobStore } from './services/index.js';

const { upgradeWebSocket, websocket } = createBunWebSocket();

// WebSocket lives here (not in app.ts) so tests can import app.ts without
// pulling in hono/bun, which requires the Bun runtime.
app.get(
  '/ws',
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      ws.send(JSON.stringify({ type: 'connected' }));
    },
    onClose() {},
  })),
);

console.log('API running at http://localhost:3001');

// Reconcile orphaned jobs on startup (fire and forget).
// Any job that was 'running' when the server last shut down is marked 'error'.
void getJobStore()
  .then((store) => store.reconcileOrphanedJobs())
  .then((count) => {
    if (count > 0) {
      console.log(`[startup] Reconciled ${count} orphaned job(s) → status=error`);
    }
  })
  .catch((err) => {
    console.error('[startup] Failed to reconcile orphaned jobs:', err);
  });

export default {
  port: 3001,
  fetch: app.fetch,
  websocket,
  // Dispatch now returns in ms (async job); this timeout protects other
  // long-polling endpoints. Bun's maximum is 255s — values above throw
  // ERR_INVALID_ARG_TYPE at boot.
  idleTimeout: 255,
};
