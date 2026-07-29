import { describe, expect, it } from 'vitest';
import { resolveAdvisoryDispositions } from './advisory-disposition.js';
import type { FalsePositiveEntry } from './false-positives.js';

describe('resolveAdvisoryDispositions', () => {
  it('marks catalog matches as Rejected from structured finding fields', () => {
    const catalog: FalsePositiveEntry[] = [
      {
        title: 'Health endpoint',
        pattern: '/health endpoint',
        rationale: 'Spec-intended degraded response.',
        matchesSummary: (summary) => summary.includes('/health'),
      },
    ];
    const rows = resolveAdvisoryDispositions(
      [
        {
          id: 'adv-1',
          severity: 'low',
          blocking: false,
          summary: 'Rules violation on endpoint shape',
          detail: 'The structured review detail names the /health endpoint.',
        },
      ],
      catalog,
      'code-review',
    );
    expect(rows[0]).toMatchObject({
      disposition: 'Rejected',
      rationale: 'Spec-intended degraded response.',
    });
  });

  it('defaults unknown advisories to Deferred', () => {
    const rows = resolveAdvisoryDispositions(
      [
        {
          id: 'adv-2',
          severity: 'info',
          blocking: false,
          summary: 'Weak test coverage on new module',
        },
      ],
      [],
      'code-review',
    );
    expect(rows[0]!.disposition).toBe('Deferred');
  });

  it('only matches catalog entries that apply to the current stage', () => {
    const catalog: FalsePositiveEntry[] = [
      {
        title: 'Sequential artifact',
        pattern: 'pair-spec-and-plan-files',
        appliesTo: ['spec-draft', 'plan-draft'],
        rationale: 'Spec and plan artifacts are reviewed sequentially.',
        matchesSummary: (summary) => summary.includes('pair-spec-and-plan-files'),
      },
    ];

    const advisory = {
      id: 'adv-3',
      severity: 'low' as const,
      blocking: false,
      summary: 'pair-spec-and-plan-files',
    };

    expect(resolveAdvisoryDispositions([advisory], catalog, 'spec-draft')[0]).toMatchObject({
      disposition: 'Rejected',
    });
    expect(resolveAdvisoryDispositions([advisory], catalog, 'plan-draft')[0]).toMatchObject({
      disposition: 'Rejected',
    });
    expect(resolveAdvisoryDispositions([advisory], catalog, 'code-review')[0]).toMatchObject({
      disposition: 'Deferred',
    });
  });
});
