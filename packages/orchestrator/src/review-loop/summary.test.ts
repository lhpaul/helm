import { describe, expect, it } from 'vitest';
import { REVIEW_LOOP_SUMMARY_MARKER, formatReviewLoopSummaryComment } from './summary.js';

describe('formatReviewLoopSummaryComment', () => {
  it('includes marker, disposition table, and ADR-036 note', () => {
    const body = formatReviewLoopSummaryComment({
      cyclesCompleted: 2,
      externalProvider: 'haystack',
      advisories: [
        {
          finding: {
            id: 'fp:rules:1',
            severity: 'low',
            blocking: false,
            summary: 'Rules violation on CHANGELOG',
          },
          disposition: 'Rejected',
          rationale: 'Known Haystack false positive.',
        },
      ],
    });

    expect(body).toContain(REVIEW_LOOP_SUMMARY_MARKER);
    expect(body).toContain('**External review:** haystack');
    expect(body).toContain('**Rejected**');
    expect(body).toContain('Do not re-run external review solely to clear advisories');
  });

  it('escapes pipe characters in table cells', () => {
    const body = formatReviewLoopSummaryComment({
      cyclesCompleted: 1,
      externalProvider: 'haystack',
      advisories: [
        {
          finding: {
            id: 'a|b',
            severity: 'low',
            blocking: false,
            summary: 'summary | with pipe',
          },
          disposition: 'Deferred',
          rationale: 'rationale | note',
        },
      ],
    });
    expect(body).toContain('summary \\| with pipe');
  });
});
