import type { StopRuleEscalationReason } from './stop-rule.js';
import { upsertPRCommentByMarker } from '../specialists/pr-helpers.js';
import type { RunGh } from '../specialists/git-helpers.js';

export const REVIEW_LOOP_ESCALATION_MARKER = '<!-- helm:review-loop-escalation -->';

export type ReviewLoopEscalationCommentInput = {
  reason: StopRuleEscalationReason;
  message: string;
  cyclesCompleted: number;
  externalReason?: string;
  /** Lifetime lane counters (ADR-042), when the caller knows them. */
  cumulative?: { cyclesTotal: number; maxCyclesCumulative: number };
};

/**
 * Renders the marker comment posted on the PR when the review loop escalates.
 * `externalReason` carries the adapter's own wording (e.g. `unavailable`) so an
 * operator can tell an external-provider escalation from an internal stop-rule.
 *
 * The comment is updated in place on every escalation (see
 * `upsertReviewLoopEscalationComment`), so it must render the **current** state
 * on its own — the reader has no earlier copy to compare it against.
 */
export function formatReviewLoopEscalationComment(input: ReviewLoopEscalationCommentInput): string {
  const lines = [
    REVIEW_LOOP_ESCALATION_MARKER,
    '## Review loop escalated',
    '',
    `**Reason:** \`${input.reason}\``,
    '',
    input.message,
    '',
    `- Cycles completed: ${input.cyclesCompleted}`,
  ];

  if (input.cumulative) {
    lines.push(
      `- Lifetime cycles for this lane: ${input.cumulative.cyclesTotal} of ${input.cumulative.maxCyclesCumulative}`,
    );
  }

  if (input.externalReason) {
    lines.push(`- External signal: \`${input.externalReason}\``);
  }

  lines.push(
    '',
    '_Human review required before merge._',
    '',
    '_Updated in place on each escalation; the full escalation history is on the item._',
  );
  return lines.join('\n');
}

/**
 * Creates or updates the escalation comment on the PR (ADR-036 §6, lhpaul/helm#93).
 *
 * Upsert, not append: a still-blocked item re-escalates on every re-dispatch,
 * and appending buried the PR under identical comments. The escalation history
 * lives on the item's history events, which are already idempotent per
 * `(lane, reason, cyclesTotal)` (ADR-042 §5).
 */
export async function upsertReviewLoopEscalationComment(
  input: ReviewLoopEscalationCommentInput & {
    prUrl: string;
    githubToken: string;
    runGh?: RunGh;
  },
): Promise<void> {
  const body = formatReviewLoopEscalationComment(input);

  await upsertPRCommentByMarker(
    {
      prUrl: input.prUrl,
      body,
      githubToken: input.githubToken,
      marker: REVIEW_LOOP_ESCALATION_MARKER,
    },
    input.runGh,
  );
}
