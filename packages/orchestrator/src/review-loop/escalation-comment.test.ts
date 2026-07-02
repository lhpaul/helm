import { describe, expect, it } from 'vitest';
import {
  formatReviewLoopEscalationComment,
  REVIEW_LOOP_ESCALATION_MARKER,
} from './escalation-comment.js';

describe('formatReviewLoopEscalationComment', () => {
  it('includes marker, reason, and evidence', () => {
    const body = formatReviewLoopEscalationComment({
      reason: 'external_skip_evidence',
      message: 'External review skipped (unavailable) with evidence: ready',
      cyclesCompleted: 2,
      externalReason: 'unavailable',
      evidence: {
        kind: 'analysis_ready',
        detail: 'Haystack analysisStatus=ready while triage was unavailable',
      },
    });

    expect(body).toContain(REVIEW_LOOP_ESCALATION_MARKER);
    expect(body).toContain('`external_skip_evidence`');
    expect(body).toContain('analysisStatus=ready');
    expect(body).toContain('Cycles completed: 2');
  });
});
