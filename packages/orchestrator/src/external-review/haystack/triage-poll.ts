import type { ExternalReviewContext } from '../types.js';
import type { ExternalReviewResult } from '../types.js';
import {
  buildHaystackPrRef,
  haystackTriageAuthErrorReason,
  haystackTriageCompletionState,
  parseHaystackJson,
} from './normalize.js';
import type { HaystackReviewConfig, HaystackTriageJson, RunHaystack, SleepFn } from './types.js';

export type PollHaystackTriageResult =
  | { kind: 'completed'; payload: HaystackTriageJson }
  | { kind: 'unavailable' }
  | { kind: 'auth_error'; reason: 'unauthorized' | 'forbidden' }
  | { kind: 'pending_timeout' }
  | { kind: 'call_timeout' };

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function elapsedMs(startedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - startedAtMs);
}

function perCallTimeoutMs(remainingMs: number): number {
  const half = Math.floor(remainingMs / 2);
  return Math.max(1, half);
}

/**
 * Polls `haystack triage <PR> --json --no-wait` until analysis completes or the
 * configured timeout budget is exhausted (haystack-reviewer.sh semantics).
 */
export async function pollHaystackTriage(
  ctx: ExternalReviewContext,
  config: HaystackReviewConfig,
  runHaystack: RunHaystack,
  sleep: SleepFn = defaultSleep,
  now: () => number = Date.now,
): Promise<PollHaystackTriageResult> {
  const prRef = buildHaystackPrRef(ctx);
  const budgetMs = config.timeoutSec * 1000;
  const pollIntervalMs = config.pollIntervalSec * 1000;
  const startedAt = now();

  while (true) {
    const elapsed = elapsedMs(startedAt, now());
    const remainingMs = budgetMs - elapsed;
    if (remainingMs <= 0) {
      return { kind: 'pending_timeout' };
    }

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await runHaystack(['triage', prRef, '--json', '--no-wait'], {
        timeoutMs: perCallTimeoutMs(remainingMs),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return { kind: 'unavailable' };
      throw err;
    }

    if (result.exitCode === 124) {
      if (elapsedMs(startedAt, now()) >= budgetMs) return { kind: 'call_timeout' };
      continue;
    }

    const payload = parseHaystackJson<HaystackTriageJson>(result.stdout);
    if (!payload) {
      if (result.exitCode !== 0) return { kind: 'unavailable' };
      return { kind: 'unavailable' };
    }

    const authReason = haystackTriageAuthErrorReason(payload);
    if (authReason) return { kind: 'auth_error', reason: authReason };

    const completion = haystackTriageCompletionState(payload);
    if (completion === 'none') return { kind: 'unavailable' };
    if (completion === 'completed') return { kind: 'completed', payload };

    const elapsedAfterCall = elapsedMs(startedAt, now());
    if (elapsedAfterCall + pollIntervalMs >= budgetMs) {
      return { kind: 'pending_timeout' };
    }
    await sleep(pollIntervalMs);
  }
}

export function mapPollFailureToExternalResult(
  failure: Exclude<PollHaystackTriageResult, { kind: 'completed' }>,
): ExternalReviewResult {
  switch (failure.kind) {
    case 'unavailable':
      return { status: 'skipped', reason: 'unavailable' };
    case 'auth_error':
      return { status: 'skipped', reason: 'unavailable' };
    case 'pending_timeout':
      return { status: 'escalate', reason: 'haystack pending_timeout' };
    case 'call_timeout':
      return { status: 'escalate', reason: 'haystack timeout' };
  }
}
