import type { ReviewerResult } from '../specialists/reviewer-fanout.js';
import {
  countGateFindings,
  DEFAULT_REMEDIATE_SEVERITY,
  type RemediateSeverity,
} from './remediate-gate.js';

/** Sum of gate-severity findings across reviewer results (ADR-036 stop-rule signal). */
export function countBlockingFindings(
  results: ReviewerResult[],
  severity: RemediateSeverity = DEFAULT_REMEDIATE_SEVERITY,
): number {
  return results.reduce((sum, r) => {
    if (!r.findings) return sum;
    return sum + countGateFindings(r.findings, severity);
  }, 0);
}

export type StopRuleEscalationReason =
  | 'max_cycles'
  | 'max_cycles_cumulative'
  | 'no_progress'
  | 'adjudication_conflict'
  | 'external_escalate'
  | 'external_repeated_skip';

export type StopRuleEvaluation =
  | { escalate: false }
  | { escalate: true; reason: StopRuleEscalationReason };

/**
 * Returns whether the internal review loop should stop and escalate to a human.
 * Call before starting another remediate cycle (after fan-out reported blockers).
 *
 * `cumulativeCycle` counts remediation passes across *all* dispatches for this
 * item (ADR-042). It is checked first: once the lifetime budget is gone, the
 * per-dispatch burst limit is no longer the interesting signal — a manual
 * re-dispatch resetting `cycle` to 1 is precisely what it exists to catch.
 * A cross-dispatch `no_progress` streak keeps the plain `no_progress` reason;
 * the streak carrying over is the mechanism, not a separate outcome.
 */
export function evaluateStopRule(input: {
  cycle: number;
  maxCycles: number;
  noProgressCycles: number;
  noProgressStreak: number;
  cumulativeCycle?: number;
  maxCyclesCumulative?: number;
}): StopRuleEvaluation {
  if (
    input.cumulativeCycle !== undefined &&
    input.maxCyclesCumulative !== undefined &&
    input.cumulativeCycle >= input.maxCyclesCumulative
  ) {
    return { escalate: true, reason: 'max_cycles_cumulative' };
  }
  if (input.cycle >= input.maxCycles) {
    return { escalate: true, reason: 'max_cycles' };
  }
  if (input.noProgressStreak >= input.noProgressCycles) {
    return { escalate: true, reason: 'no_progress' };
  }
  return { escalate: false };
}

/**
 * Updates the no-progress streak after comparing against the best (lowest) blocker
 * signals seen so far in this loop run (ADR-037 + sticky fingerprints).
 *
 * Progress is either:
 * - fewer gate-severity findings by count, or
 * - fewer unresolved sticky fingerprints from the baseline set
 *   (detects finding churn where count stays flat but titles rewrite).
 */
export function nextNoProgressStreak(
  bestBlockerCount: number | null,
  currentBlockerCount: number,
  priorStreak: number,
  bestStickyRemaining: number | null = null,
  currentStickyRemaining: number | null = null,
): number {
  if (bestBlockerCount === null) {
    return 0;
  }
  if (currentBlockerCount < bestBlockerCount) {
    return 0;
  }
  if (
    bestStickyRemaining !== null &&
    currentStickyRemaining !== null &&
    currentStickyRemaining < bestStickyRemaining
  ) {
    return 0;
  }
  return priorStreak + 1;
}
