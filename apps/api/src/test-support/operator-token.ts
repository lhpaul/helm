// Test-only helpers for the operator token (#160). The vitest setup file sets
// HELM_API_TOKEN to TEST_API_TOKEN, so route tests run with auth on.

import type { Hono } from 'hono';

/** Fake operator token used by every API test (not a real secret). */
export const TEST_API_TOKEN = 'test-operator-token-0123456789abcdef';

export const TEST_AUTH_HEADER = `Bearer ${TEST_API_TOKEN}`;

/**
 * Wraps `app.request` so every call carries the test operator token, unless
 * the call sets its own `Authorization` header.
 */
export function withOperatorToken(app: Hono): { request: Hono['request'] } {
  return {
    request: (input, init, ...rest) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('authorization')) headers.set('Authorization', TEST_AUTH_HEADER);
      return app.request(input, { ...init, headers }, ...rest);
    },
  };
}
