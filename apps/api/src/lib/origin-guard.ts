// Cross-origin (CSRF) guard for state-changing API routes (#162).
//
// The API has no authentication, so a page open in the operator's browser could
// send a "simple" cross-origin POST (form or no-cors fetch) and trigger side
// effects. Browsers always send `Origin` on cross-origin non-GET requests, so:
//   - safe methods and the signed webhooks pass;
//   - an `Origin` must be in the allowlist (matched exactly, never against
//     `Host`, so DNS rebinding does not help);
//   - without `Origin`, a cross-site/same-site `Sec-Fetch-Site` is rejected;
//   - with neither header (curl, scripts) the request passes.
// Kept free of `hono/bun` so it runs under vitest (Node).

import type { MiddlewareHandler } from 'hono';

/** Local Helm UI (Vite dev server on port 5173). */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

/** Authenticated by signature and called by GitHub/Linear servers. */
export const WEBHOOK_PATHS: ReadonlySet<string> = new Set([
  '/api/webhooks/github',
  '/api/webhooks/linear',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * Normalized `scheme://host[:port]` for a bare http(s) origin, or null when the
 * value is not one (path, query, hash, credentials, other scheme, unparsable).
 */
export function normalizeOrigin(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/') return null;
  return url.origin;
}

export interface AllowedOrigins {
  origins: ReadonlySet<string>;
  warnings: string[];
}

/** Default UI origins plus the comma-separated `HELM_ALLOWED_ORIGINS`. */
export function resolveAllowedOrigins(env: Record<string, string | undefined>): AllowedOrigins {
  const origins = new Set<string>(DEFAULT_ALLOWED_ORIGINS);
  const warnings: string[] = [];
  for (const entry of (env.HELM_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = normalizeOrigin(trimmed);
    if (origin) {
      origins.add(origin);
    } else {
      warnings.push(
        `[startup] Ignoring HELM_ALLOWED_ORIGINS entry ${JSON.stringify(trimmed)}: ` +
          'expected an http(s) origin such as https://helm.example.com',
      );
    }
  }
  return { origins, warnings };
}

export interface OriginCheckInput {
  method: string;
  path: string;
  origin?: string | null;
  secFetchSite?: string | null;
}

export function checkOrigin(
  { method, path, origin, secFetchSite }: OriginCheckInput,
  allowed: ReadonlySet<string>,
): 'allow' | 'reject' {
  if (SAFE_METHODS.has(method.toUpperCase())) return 'allow';
  if (WEBHOOK_PATHS.has(path)) return 'allow';

  if (origin !== undefined && origin !== null) {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && allowed.has(normalized) ? 'allow' : 'reject';
  }

  if (secFetchSite !== undefined && secFetchSite !== null) {
    return ALLOWED_FETCH_SITES.has(secFetchSite.trim().toLowerCase()) ? 'allow' : 'reject';
  }

  // Neither header: not a browser cross-origin request (curl, scripts).
  return 'allow';
}

export function originGuard(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    const decision = checkOrigin(
      {
        method: c.req.method,
        path: c.req.path,
        origin,
        secFetchSite: c.req.header('sec-fetch-site'),
      },
      allowed,
    );
    if (decision === 'reject') {
      console.warn(
        `[origin-guard] Rejected ${c.req.method} ${JSON.stringify(c.req.path)} ` +
          `origin=${JSON.stringify(origin ?? null)}`,
      );
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }
    await next();
  };
}
