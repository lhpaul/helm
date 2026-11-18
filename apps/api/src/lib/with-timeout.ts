/**
 * Bounds a promise's wait with a timeout.
 *
 * The issue-tracker adapters' GraphQL write paths (`ensureSubStages` /
 * `setSubStage`) have no request timeout — a stalled tracker connection would
 * otherwise hang the caller indefinitely (the writeback runs in the request
 * path, and the backfill runs a sequential batch). This bounds the wait so a
 * hung call rejects instead of blocking forever.
 *
 * Note: this bounds the *wait*, not the underlying socket — the adapters don't
 * accept an AbortSignal, so the in-flight request is abandoned rather than
 * cancelled. That is sufficient for the best-effort writeback (the result is
 * discarded anyway) and the short-lived backfill CLI. True cancellation would
 * require plumbing an AbortSignal through the adapters package (follow-up).
 *
 * @param promise - the work to bound.
 * @param ms      - timeout in milliseconds.
 * @param label   - included in the timeout error message for diagnostics.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Default bound for a single tracker write (`ensureSubStages` / `setSubStage`).
 * Matches the 10s `AbortController` timeout `GitHubProjectsAdapter.registerWebhook`
 * already uses — the established external-call timeout in this codebase.
 */
export const TRACKER_WRITE_TIMEOUT_MS = 10_000;
