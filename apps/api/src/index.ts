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
  // Bun's default idleTimeout is 10s — raise to 305s (5s above the 300s
  // DEFAULT_TIMEOUT_MS in ClaudeCodeRuntime) so the HTTP connection is
  // guaranteed to outlive the agent process timeout.
  // NOTE: stopgap. The proper fix is async dispatch (job id + poll/websocket);
  // tracked for Session 11. Runs exceeding 300s are killed by the runtime
  // timeout before this idle timeout fires.
  idleTimeout: 305,
};
