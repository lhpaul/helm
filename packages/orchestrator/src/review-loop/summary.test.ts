import { describe, expect, it } from 'vitest';
import {
  REVIEW_LOOP_SUMMARY_MARKER,
  buildAdvisorySummaryRows,
  formatReviewLoopSummaryComment,
} from './summary.js';
import { builtInFalsePositiveEntries } from './false-positives.js';

describe('formatReviewLoopSummaryComment', () => {
  it('includes marker, disposition table, and ADR-036 note', () => {
    const body = formatReviewLoopSummaryComment({
      cyclesCompleted: 2,
      externalProvider: 'coderabbit',
      advisories: [
        {
          finding: {
            id: 'fp:rules:1',
            severity: 'low',
            blocking: false,
            summary: 'Rules violation on CHANGELOG',
          },
          disposition: 'Rejected',
          rationale: 'Known external-reviewer false positive.',
        },
      ],
    });

    expect(body).toContain(REVIEW_LOOP_SUMMARY_MARKER);
    expect(body).toContain('**External review:** coderabbit');
    expect(body).toContain('**Rejected**');
    expect(body).toContain('Do not re-run external review solely to clear advisories');
  });

  it('escapes pipe characters in table cells', () => {
    const body = formatReviewLoopSummaryComment({
      cyclesCompleted: 1,
      externalProvider: 'coderabbit',
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

describe('buildAdvisorySummaryRows', () => {
  it('passes the current stage through to advisory disposition matching', () => {
    const advisory = {
      id: 'adv-1',
      severity: 'low' as const,
      blocking: false,
      summary: 'pair-spec-and-plan-files',
    };
    const rows = buildAdvisorySummaryRows(
      [advisory],
      [
        {
          title: 'Sequential artifact',
          pattern: 'pair-spec-and-plan-files',
          appliesTo: ['spec-draft', 'plan-draft'],
          rationale: 'Sequential artifact review.',
          matchesSummary: (summary) => summary.includes('pair-spec-and-plan-files'),
        },
      ],
      'code-review',
    );

    expect(rows[0]!.disposition).toBe('Deferred');
    expect(
      buildAdvisorySummaryRows([advisory], builtInFalsePositiveEntries(), 'spec-draft')[0],
    ).toMatchObject({
      disposition: 'Rejected',
    });
  });

  it('builds summary dispositions from structured finding metadata', () => {
    const advisory = {
      id: 'pair-spec-and-plan-files',
      severity: 'low' as const,
      blocking: false,
      summary: 'Sequential review concern',
    };

    expect(
      buildAdvisorySummaryRows([advisory], builtInFalsePositiveEntries(), 'spec-draft')[0],
    ).toMatchObject({
      disposition: 'Rejected',
    });
  });
});
