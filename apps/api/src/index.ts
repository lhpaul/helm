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
};
