import type { StopRuleEscalationReason } from './stop-rule.js';

/**
 * Review-loop lanes with independent lifetime budgets (ADR-042).
 *
 * A draft-artifact loop and the implementation-PR loop review different
 * artifacts, so they never share a budget: burning the spec-draft budget must
 * not pre-escalate the item's later code review. The lane key is the workflow
 * stage the loop runs in — a subset of WorkflowStage.
 */
export type ReviewLoopLane = 'code-review' | 'spec-draft' | 'plan-draft';

/** Durable cross-dispatch counters for one lane of one item. */
export type ReviewLoopLedgerEntry = {
  /** Remediation passes completed for this lane across every dispatch. */
  cyclesTotal: number;
  /** no-progress streak (ADR-038 signal) carried across dispatches. */
  noProgressStreak: number;
  /** Lowest blocker count observed so far — absent until the first pass. */
  bestBlockerCount?: number;
  /** ISO 8601 — set when the loop last escalated for this lane. */
  escalatedAt?: string;
  escalationReason?: StopRuleEscalationReason;
  /** ISO 8601 */
  updatedAt: string;
};

/** Per-item ledger, keyed by lane. Lanes are absent until their first pass. */
export type ReviewLoopLedger = Partial<Record<ReviewLoopLane, ReviewLoopLedgerEntry>>;

/** The counters a loop run writes back after a pass or an escalation. */
export type ReviewLoopLedgerUpdate = {
  cyclesTotal: number;
  noProgressStreak: number;
  bestBlockerCount?: number;
  escalatedAt?: string;
  escalationReason?: StopRuleEscalationReason;
};

/**
 * Persists one lane's counters. Called after every completed remediation pass
 * and on escalation, so a manual re-dispatch resumes from the same budget.
 */
export type PersistReviewLoopLedgerFn = (input: {
  lane: ReviewLoopLane;
  update: ReviewLoopLedgerUpdate;
}) => Promise<void> | void;

/** In-run seed derived from the durable entry (defaults when the lane is new). */
export type ReviewLoopLedgerSeed = {
  /** Remediation passes completed before this dispatch started. */
  priorCycles: number;
  noProgressStreak: number;
  bestBlockerCount: number | null;
};

/**
 * Seeds a loop run from the durable ledger.
 *
 * `bestBlockerCount` is carried alongside the streak on purpose: without it the
 * first cycle of every dispatch has no baseline to compare against and
 * `nextNoProgressStreak` resets to 0, which is exactly the reset this ADR
 * closes.
 */
export function seedFromReviewLoopLedger(entry?: ReviewLoopLedgerEntry): ReviewLoopLedgerSeed {
  return {
    priorCycles: entry?.cyclesTotal ?? 0,
    noProgressStreak: entry?.noProgressStreak ?? 0,
    bestBlockerCount: entry?.bestBlockerCount ?? null,
  };
}
