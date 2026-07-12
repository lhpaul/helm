import { describe, expect, it } from 'vitest';
import type { ReviewerResult } from '../specialists/reviewer-fanout.js';
import {
  collectGateFindingFingerprints,
  countStickyRemaining,
  createStickyLane,
  fingerprintFindingTitle,
  observeStickyLane,
  parseFindingFingerprints,
  recordStickyImprovement,
} from './finding-fingerprint.js';

describe('fingerprintFindingTitle', () => {
  it('collapses RLS title rewrites onto the same tenant-isolation theme', () => {
    const a = fingerprintFindingTitle('Missing RLS coverage on summary and properties list');
    const b = fingerprintFindingTitle(
      'Incomplete tenant-isolation coverage for summary and list endpoints',
    );
    expect(a).toContain('tenant-isolation');
    expect(b).toContain('tenant-isolation');
    expect(a.split('|')[0]).toBe(b.split('|')[0]);
  });

  it('keeps file paths in the fingerprint when present', () => {
    const fp = fingerprintFindingTitle(
      'Unvalidated property ID in apps/api/src/routes/debts.ts can 500',
    );
    expect(fp).toContain('apps/api/src/routes/debts.ts');
  });
});

describe('parseFindingFingerprints', () => {
  const body = `# Test Review
## Findings
- **MEDIUM** · Missing RLS coverage on summary and properties list
  detail
- **LOW** · Brittle order-dependent assertions
- **HIGH** · Common-expenses UF amounts are lost
`;

  it('includes MEDIUM only for medium_and_above', () => {
    expect(parseFindingFingerprints(body, 'critical_high')).toHaveLength(1);
    expect(parseFindingFingerprints(body, 'medium_and_above')).toHaveLength(2);
  });
});

describe('sticky remaining', () => {
  it('counts how many baseline fingerprints remain', () => {
    const baseline = new Set(['tenant-isolation|summary', 'empty-state|properties']);
    const current = new Set(['tenant-isolation|summary', 'new-finding|foo']);
    expect(countStickyRemaining(baseline, current)).toBe(1);
    expect(countStickyRemaining(null, current)).toBe(0);
  });

  it('collects fingerprints from reviewer comment bodies', () => {
    const results: ReviewerResult[] = [
      {
        kind: 'test',
        status: 'done',
        costUsd: 0,
        durationMs: 0,
        commentPosted: true,
        findings: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
        commentBody: '- **MEDIUM** · Missing tenant-isolation coverage on summary/list endpoints\n',
      },
    ];
    const fps = collectGateFindingFingerprints(results, 'medium_and_above');
    expect([...fps].some((fp) => fp.includes('tenant-isolation'))).toBe(true);
  });

  it('tracks sticky remaining per lane without sharing baselines', () => {
    const internal = createStickyLane();
    const external = createStickyLane();

    expect(observeStickyLane(internal, new Set(['theme|a', 'theme|b']))).toBe(2);
    recordStickyImprovement(internal, 2);
    expect(observeStickyLane(internal, new Set(['theme|a']))).toBe(1);
    recordStickyImprovement(internal, 1);
    expect(internal.bestRemaining).toBe(1);

    // External ids must not be compared against the internal baseline.
    expect(observeStickyLane(external, new Set(['hs-finding-1']))).toBe(1);
    recordStickyImprovement(external, 1);
    expect(external.baseline).not.toEqual(internal.baseline);
    expect(observeStickyLane(external, new Set(['hs-finding-2']))).toBe(0);
  });
});
