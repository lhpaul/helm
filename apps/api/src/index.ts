import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { HELM_VERSION } from '@helm/shared';

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    version: HELM_VERSION,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  }),
);

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
