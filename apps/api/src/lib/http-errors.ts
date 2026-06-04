import { WorkflowTransitionError } from '@helm/workflow';
import {
  ItemAlreadyExistsError,
  ItemNotFoundError,
  StageMismatchError,
} from '../services/errors.js';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import { JOB_ID_REGEX } from '../services/job-store.js';

// ── HTTP error conventions (ADR-031) ──────────────────────────────────────────
//
// Centralizes the two patterns the API routes hand-rolled across items.ts,
// dispatch.ts, rollback.ts, and jobs.ts:
//   1. Path-param validation (EXTERNAL_ID_REGEX / JOB_ID_REGEX + dot-defense).
//   2. Error-class → HTTP status mapping.
//
// The response BYTES are unchanged versus the inline patterns — every existing
// route test passes unmodified. See ADR-031 for the locked design decisions.

/**
 * Canonical error-response body. Always carries an `error` string; callers may
 * merge additional structured fields (`details`, `missing_context`,
 * `runningJobId`, …) via the `extras` parameter of {@link mapErrorToResponse}.
 */
export type ErrorResponseBody = { error: string } & Record<string, unknown>;

/**
 * Discriminated-union result for path-param validators. On success the route
 * uses `value`; on failure it returns `response.body` with `response.status`.
 * Validators never throw — the route stays in straight-line control flow.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: { body: ErrorResponseBody; status: 400 } };

/**
 * Validates an `externalId` path-param using EXTERNAL_ID_REGEX plus an explicit
 * '.' / '..' defense-in-depth check (mirrors the inline pattern previously
 * duplicated across dispatch.ts / rollback.ts / jobs.ts). The dot checks are
 * redundant given the regex's leading-dot lookahead, but kept explicit so the
 * intent survives a future regex relaxation before the value reaches any path
 * operation. Returns the validated value or a 400-response payload.
 */
export function validateExternalId(value: string): ValidationResult<string> {
  if (!EXTERNAL_ID_REGEX.test(value) || value === '.' || value === '..') {
    return {
      ok: false,
      response: { body: { error: `Invalid externalId: "${value}"` }, status: 400 },
    };
  }
  return { ok: true, value };
}

/**
 * Validates a `jobId` path-param against JOB_ID_REGEX (UUID v4). Returns the
 * validated value or a 400-response payload. Mirrors the inline check in
 * jobs.ts.
 */
export function validateJobId(value: string): ValidationResult<string> {
  if (!JOB_ID_REGEX.test(value)) {
    return { ok: false, response: { body: { error: `Invalid jobId: "${value}"` }, status: 400 } };
  }
  return { ok: true, value };
}

/**
 * Maps a thrown error to a stable HTTP response. Recognises the four canonical
 * error classes (returning each error's own `.message`, byte-identical to the
 * strings the routes built by hand) plus the unknown → 500 catch-all:
 *
 *   - ItemNotFoundError      → 404
 *   - ItemAlreadyExistsError → 409
 *   - StageMismatchError     → 400
 *   - WorkflowTransitionError→ 422
 *   - Unknown                → 500 with a generic message (no error.message leak)
 *
 * Callers may pass an `extras` record merged into the body (forward-compatible
 * hook for fields like `details` / `missing_context` / `runningJobId`; today
 * those bodies are emitted inline, not via this mapper — see ADR-031). The
 * canonical `error` field always wins: `extras` is spread first so it can never
 * clobber the mapped message.
 *
 * NOTE on the 500 branch: route handlers re-throw when `status === 500` so that
 * unrecognised errors keep flowing to Hono's default handler (preserving the
 * existing 500 bytes). The 500 branch here is exercised directly by
 * http-errors.test.ts.
 */
export function mapErrorToResponse(
  error: unknown,
  extras: Record<string, unknown> = {},
): { body: ErrorResponseBody; status: 400 | 404 | 409 | 422 | 500 } {
  if (error instanceof ItemNotFoundError) {
    return { body: { ...extras, error: error.message }, status: 404 };
  }
  if (error instanceof ItemAlreadyExistsError) {
    return { body: { ...extras, error: error.message }, status: 409 };
  }
  if (error instanceof StageMismatchError) {
    return { body: { ...extras, error: error.message }, status: 400 };
  }
  if (error instanceof WorkflowTransitionError) {
    return { body: { ...extras, error: error.message }, status: 422 };
  }
  return { body: { ...extras, error: 'Internal server error' }, status: 500 };
}
