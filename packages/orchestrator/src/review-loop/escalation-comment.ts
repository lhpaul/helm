import type { HaystackSkipEvidence } from '../external-review/haystack/skip-evidence.js';
import type { StopRuleEscalationReason } from './stop-rule.js';

export const REVIEW_LOOP_ESCALATION_MARKER = '<!-- helm:review-loop-escalation -->';

export function formatReviewLoopEscalationComment(input: {
  reason: StopRuleEscalationReason;
  message: string;
  cyclesCompleted: number;
  evidence?: HaystackSkipEvidence;
  externalReason?: string;
}): string {
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

  if (input.externalReason) {
    lines.push(`- External signal: \`${input.externalReason}\``);
  }
  if (input.evidence) {
    lines.push(`- Evidence: ${input.evidence.detail}`);
  }

  lines.push('', '_Human review required before merge._');
  return lines.join('\n');
}
