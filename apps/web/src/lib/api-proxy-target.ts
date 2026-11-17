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
