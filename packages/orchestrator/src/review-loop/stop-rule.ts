import type { ReviewerResult } from '../specialists/reviewer-fanout.js';

/** Sum of CRITICAL + HIGH findings across reviewer results (ADR-036 stop-rule signal). */
export function countBlockingFindings(results: ReviewerResult[]): number {
  return results.reduce((sum, r) => {
    if (!r.findings) return sum;
    return sum + r.findings.critical + r.findings.high;
  }, 0);
}

export type StopRuleEscalationReason = 'max_cycles' | 'no_progress';

export type StopRuleEvaluation =
  | { escalate: false }
  | { escalate: true; reason: StopRuleEscalationReason };

/**
 * Returns whether the internal review loop should stop and escalate to a human.
 * Call before starting another remediate cycle (after fan-out reported blockers).
 */
export function evaluateStopRule(input: {
  cycle: number;
  maxCycles: number;
  noProgressCycles: number;
  noProgressStreak: number;
}): StopRuleEvaluation {
  if (input.cycle >= input.maxCycles) {
    return { escalate: true, reason: 'max_cycles' };
  }
  if (input.noProgressStreak >= input.noProgressCycles) {
    return { escalate: true, reason: 'no_progress' };
  }
  return { escalate: false };
}

/**
 * Updates the no-progress streak after comparing blocker counts between cycles.
 * Streak increments when the count did not decrease; resets when it did.
 */
export function nextNoProgressStreak(
  priorBlockerCount: number | null,
  currentBlockerCount: number,
  priorStreak: number,
): number {
  if (priorBlockerCount === null) return 0;
  if (currentBlockerCount < priorBlockerCount) return 0;
  return priorStreak + 1;
}
