import { describe, expect, it } from 'vitest';
import { resolveAdvisoryDispositions } from './advisory-disposition.js';
import type { FalsePositiveEntry } from './false-positives.js';

describe('resolveAdvisoryDispositions', () => {
  it('marks catalog matches as Rejected', () => {
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
          summary: 'Rules violation on /health endpoint shape',
        },
      ],
      catalog,
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
    );
    expect(rows[0]!.disposition).toBe('Deferred');
  });
});
