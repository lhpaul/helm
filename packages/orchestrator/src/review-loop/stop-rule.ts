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
  | 'no_progress'
  | 'adjudication_conflict'
  | 'external_escalate'
  | 'external_skip_evidence'
  | 'external_repeated_skip';

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
 * Updates the no-progress streak after comparing against the best (lowest) blocker
 * count seen so far in this loop run (ADR-037). Detects oscillation when blockers
 * drop then rise again (e.g. remediation reverts a prior fix).
 */
export function nextNoProgressStreak(
  bestBlockerCount: number | null,
  currentBlockerCount: number,
  priorStreak: number,
): number {
  if (bestBlockerCount === null) {
    return 0;
  }
  if (currentBlockerCount < bestBlockerCount) {
    return 0;
  }
  return priorStreak + 1;
}
