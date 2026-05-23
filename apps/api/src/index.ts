import { createBunWebSocket } from 'hono/bun';
import { app } from './app.js';

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

export default {
  port: 3001,
  fetch: app.fetch,
  websocket,
  // Synchronous dispatch spawns Claude Code, which can run for minutes.
  // Bun's default idleTimeout is 10s — raise to 255s (Bun's MAXIMUM; values
  // above 255 throw ERR_INVALID_ARG_TYPE at boot).
  // KNOWN LIMITATION: the runtime's DEFAULT_TIMEOUT_MS is 300s, which exceeds
  // this 255s HTTP cap. A run lasting 255-300s will drop the HTTP connection
  // while the agent keeps running. This is inherent to synchronous dispatch and
  // is resolved by async dispatch (job id + poll/websocket) — tracked for Session 11.
  idleTimeout: 255,
};
