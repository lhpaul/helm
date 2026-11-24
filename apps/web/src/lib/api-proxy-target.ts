// Host the Vite dev proxy uses to reach the API (#159). Mirrors the API's
// HELM_API_HOST: loopback by default, wildcard binds reached over loopback,
// any other address used as is.

const API_PORT = 3001;

export function resolveApiProxyHost(env: Record<string, string | undefined>): string {
  const host = env.HELM_API_HOST?.trim();
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '[::1]';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function apiProxyTargets(env: Record<string, string | undefined>): {
  http: string;
  ws: string;
} {
  const host = resolveApiProxyHost(env);
  return { http: `http://${host}:${API_PORT}`, ws: `ws://${host}:${API_PORT}` };
}

// Operator token for the API (#160, ADR-045). Read from the shell that runs
// `pnpm dev` (process.env, never a VITE_ variable) and added server-side by the
// proxy, so the SPA bundle and the browser never hold it.
export function apiProxyAuthHeaders(
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const token = env.HELM_API_TOKEN?.trim();
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

export interface ApiProxyEntry {
  target: string;
  changeOrigin?: boolean;
  ws?: boolean;
  headers?: Record<string, string>;
}

/** Vite `server.proxy` entries for `/api` and `/ws`. */
export function apiProxyConfig(
  env: Record<string, string | undefined>,
): Record<'/api' | '/ws', ApiProxyEntry> {
  const targets = apiProxyTargets(env);
  const headers = apiProxyAuthHeaders(env);
  return {
    // changeOrigin matches Vite's shorthand for a string target (used before #160).
    '/api': { target: targets.http, changeOrigin: true, ...(headers ? { headers } : {}) },
    '/ws': { target: targets.ws, ws: true, ...(headers ? { headers } : {}) },
  };
}
