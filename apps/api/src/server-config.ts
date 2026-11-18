// Listen config for the Bun API server. Kept free of `hono/bun` so it can be
// unit tested under vitest (Node).

export const DEFAULT_API_HOST = '127.0.0.1';
export const API_PORT = 3001;

export interface ListenConfig {
  hostname: string;
  port: number;
  /** Set when the API is exposed beyond loopback (it has no authentication). */
  warning?: string;
}

/** `HELM_API_HOST` (trimmed), or 127.0.0.1 when missing or blank. */
export function resolveApiHost(env: Record<string, string | undefined>): string {
  const raw = env.HELM_API_HOST?.trim();
  return raw ? raw : DEFAULT_API_HOST;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const octets = h.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}

export function buildListenConfig(env: Record<string, string | undefined>): ListenConfig {
  const hostname = resolveApiHost(env);
  const config: ListenConfig = { hostname, port: API_PORT };
  if (!isLoopbackHost(hostname)) {
    config.warning =
      `[startup] HELM_API_HOST=${hostname} exposes the API beyond loopback. ` +
      'The API has no authentication; restrict access with a firewall or an authenticated proxy.';
  }
  return config;
}

export function formatListenUrl({ hostname, port }: ListenConfig): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}
