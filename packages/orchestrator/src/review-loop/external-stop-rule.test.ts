import { describe, expect, it } from 'vitest';
import { evaluateExternalReviewStopRule } from './external-stop-rule.js';

describe('evaluateExternalReviewStopRule', () => {
  it('escalates immediately when adapter returns escalate', () => {
    const decision = evaluateExternalReviewStopRule({
      result: { status: 'escalate', reason: 'haystack pending_timeout' },
      skipAttempt: 1,
      maxSkipAttempts: 2,
      evidence: null,
    });
    expect(decision).toMatchObject({
      action: 'escalate',
      reason: 'external_escalate',
      externalReason: 'haystack pending_timeout',
    });
  });

  it('continues on clean, needs_fixes, and not_configured', () => {
    expect(
      evaluateExternalReviewStopRule({
        result: { status: 'clean', blockers: [], advisories: [] },
        skipAttempt: 1,
        maxSkipAttempts: 2,
        evidence: null,
      }).action,
    ).toBe('continue');

    expect(
      evaluateExternalReviewStopRule({
        result: {
          status: 'needs_fixes',
          blockers: [
            {
              id: 'b1',
              severity: 'high',
              blocking: true,
              summary: 'blocker',
            },
          ],
          advisories: [],
        },
        skipAttempt: 1,
        maxSkipAttempts: 2,
        evidence: null,
      }).action,
    ).toBe('continue');

    expect(
      evaluateExternalReviewStopRule({
        result: { status: 'skipped', reason: 'not_configured' },
        skipAttempt: 1,
        maxSkipAttempts: 2,
        evidence: null,
      }).action,
    ).toBe('continue');
  });

  it('escalates on skip evidence before max attempts', () => {
    const decision = evaluateExternalReviewStopRule({
      result: { status: 'skipped', reason: 'unavailable' },
      skipAttempt: 1,
      maxSkipAttempts: 2,
      evidence: {
        kind: 'analysis_ready',
        detail: 'Haystack analysisStatus=ready while triage was unavailable',
      },
    });
    expect(decision).toMatchObject({
      action: 'escalate',
      reason: 'external_skip_evidence',
    });
  });

  it('retries when skipped without evidence under the attempt budget', () => {
    expect(
      evaluateExternalReviewStopRule({
        result: { status: 'skipped', reason: 'unavailable' },
        skipAttempt: 1,
        maxSkipAttempts: 2,
        evidence: null,
      }),
    ).toEqual({ action: 'retry', skipAttempt: 1 });
  });

  it('escalates on repeated skip when attempt budget is exhausted', () => {
    const decision = evaluateExternalReviewStopRule({
      result: { status: 'skipped', reason: 'unavailable' },
      skipAttempt: 2,
      maxSkipAttempts: 2,
      evidence: null,
    });
    expect(decision).toMatchObject({
      action: 'escalate',
      reason: 'external_repeated_skip',
      skipAttempt: 2,
    });
  });
});
