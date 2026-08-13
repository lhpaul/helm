import { describe, expect, it } from 'vitest';
import {
  formatReviewLoopEscalationComment,
  REVIEW_LOOP_ESCALATION_MARKER,
} from './escalation-comment.js';

describe('formatReviewLoopEscalationComment', () => {
  it('includes marker, reason, and external signal', () => {
    const body = formatReviewLoopEscalationComment({
      reason: 'external_repeated_skip',
      message: 'External review skipped 2 time(s) (unavailable); escalating per stop-rule',
      cyclesCompleted: 2,
      externalReason: 'unavailable',
    });

    expect(body).toContain(REVIEW_LOOP_ESCALATION_MARKER);
    expect(body).toContain('`external_repeated_skip`');
    expect(body).toContain('External signal: `unavailable`');
    expect(body).toContain('Cycles completed: 2');
  });
});
