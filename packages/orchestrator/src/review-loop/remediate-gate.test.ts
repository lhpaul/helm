import { describe, expect, it } from 'vitest';

import type { Findings, ReviewerResult } from '../specialists/reviewer-fanout.js';
import { countGateFindings, shouldRemediateForSeverity } from './remediate-gate.js';

const zero: Findings = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

describe('remediate-gate', () => {
  it('counts only CRITICAL/HIGH by default', () => {
    expect(countGateFindings({ ...zero, critical: 1, medium: 3 }, 'critical_high')).toBe(1);
    expect(countGateFindings({ ...zero, high: 2, medium: 1 }, 'critical_high')).toBe(2);
  });

  it('includes MEDIUM when severity is medium_and_above', () => {
    expect(countGateFindings({ ...zero, medium: 2 }, 'medium_and_above')).toBe(2);
    expect(countGateFindings({ ...zero, high: 1, medium: 1 }, 'medium_and_above')).toBe(2);
  });

  it('shouldRemediateForSeverity respects medium_and_above', () => {
    const result: ReviewerResult = {
      kind: 'code',
      status: 'done',
      costUsd: 0,
      durationMs: 0,
      commentPosted: true,
      findings: { ...zero, medium: 1 },
    };
    expect(shouldRemediateForSeverity([result], 'critical_high')).toBe(false);
    expect(shouldRemediateForSeverity([result], 'medium_and_above')).toBe(true);
  });
});
