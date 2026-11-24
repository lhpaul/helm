// Operator token authentication for the API (#160, ADR-045).
//
// Every /api/* route (reads and writes) and the /ws upgrade require
// `Authorization: Bearer <HELM_API_TOKEN>`. Exempt: the signed webhook routes
// (the exact WEBHOOK_PATHS shared with the #162 origin guard) and /health,
// which is never routed through this middleware.
//
// Fail closed: with HELM_API_TOKEN unset, blank or too short, protected routes
// answer 401. The only bypass is the explicit HELM_API_AUTH=disabled.
// Kept free of `hono/bun` so it runs under vitest (Node).

import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'hono/utils/buffer';
import { WEBHOOK_PATHS } from './origin-guard.js';

export const MIN_TOKEN_LENGTH = 32;

export type ApiAuthMode =
  | { mode: 'token'; token: string }
  | { mode: 'disabled' }
  | { mode: 'misconfigured' };

export type ApiAuthConfig = ApiAuthMode & {
  /** Startup errors; they name variables, never their values. */
  errors: string[];
  /** Startup warnings; they name variables, never their values. */
  warnings: string[];
};

const ROLLBACK_HINT =
  'Only use it on a single-user machine or for rollback, after confirming that the public ' +
  'ingress (if any) only serves /api/webhooks/* and /health and that no non-loopback ' +
  'HELM_API_HOST bind is reachable from the network (see docs/local-dev.md, "API authentication").';

/** Resolves the auth mode from the environment. Never throws. */
export function resolveApiAuth(env: Record<string, string | undefined>): ApiAuthConfig {
  const errors: string[] = [];
  const warnings: string[] = [];

  const authSetting = env.HELM_API_AUTH?.trim() ?? '';
  if (authSetting.toLowerCase() === 'disabled') {
    warnings.push(
      '[startup] HELM_API_AUTH=disabled: the API is UNAUTHENTICATED. Any client that reaches ' +
        `it can read and change items and start agent runs. ${ROLLBACK_HINT}`,
    );
    return { mode: 'disabled', errors, warnings };
  }
  if (authSetting) {
    warnings.push(
      '[startup] Ignoring HELM_API_AUTH: the only accepted value is "disabled"; ' +
        'API authentication stays on.',
    );
  }

  const token = env.HELM_API_TOKEN?.trim() ?? '';
  if (!token) {
    errors.push(
      '[startup] HELM_API_TOKEN is not set: every /api/* route except the webhooks, and /ws, ' +
        'will answer 401. Set HELM_API_TOKEN (see apps/api/.env.example) and restart.',
    );
    return { mode: 'misconfigured', errors, warnings };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    errors.push(
      `[startup] HELM_API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters: every /api/* ` +
        'route except the webhooks, and /ws, will answer 401. Generate a longer token ' +
        '(for example `openssl rand -hex 32`) and restart.',
    );
    return { mode: 'misconfigured', errors, warnings };
  }

  return { mode: 'token', token, errors, warnings };
}

/** True for /ws and every /api path except the registered signed webhooks. */
export function isProtectedPath(path: string): boolean {
  if (path === '/ws') return true;
  if (path !== '/api' && !path.startsWith('/api/')) return false;
  return !WEBHOOK_PATHS.has(path);
}

const BEARER_RE = /^bearer[ \t]+(\S+)$/i;

/** The token of a `Bearer <token>` header (scheme case-insensitive), or null. */
export function parseBearerToken(header: string | undefined | null): string | null {
  if (typeof header !== 'string') return null;
  const match = BEARER_RE.exec(header.trim());
  return match?.[1] ?? null;
}

/** Constant-time token comparison (hashes both sides, so length does not short-circuit). */
export function tokensMatch(received: string, expected: string): Promise<boolean> {
  return timingSafeEqual(received, expected);
}

export function apiAuth(config: ApiAuthMode): MiddlewareHandler {
  return async (c, next) => {
    if (config.mode === 'disabled' || !isProtectedPath(c.req.path)) {
      await next();
      return;
    }

    if (config.mode === 'token') {
      const received = parseBearerToken(c.req.header('authorization'));
      if (received !== null && (await tokensMatch(received, config.token))) {
        await next();
        return;
      }
    }

    console.warn(`[api-auth] Unauthorized ${c.req.method} ${JSON.stringify(c.req.path)}`);
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Unauthorized' }, 401);
  };
}
