import { describe, expect, it } from 'vitest';
import { evaluateExternalReviewStopRule } from './external-stop-rule.js';

describe('evaluateExternalReviewStopRule', () => {
  it('escalates immediately when adapter returns escalate', () => {
    const decision = evaluateExternalReviewStopRule({
      result: { status: 'escalate', reason: 'coderabbit pending_timeout' },
      skipAttempt: 1,
      maxSkipAttempts: 2,
    });
    expect(decision).toMatchObject({
      action: 'escalate',
      reason: 'external_escalate',
      externalReason: 'coderabbit pending_timeout',
    });
  });

  it('defers when adapter reports analysis pending', () => {
    const decision = evaluateExternalReviewStopRule({
      result: {
        status: 'deferred',
        reason: 'analysis_pending',
        providerReason: 'pending_timeout',
      },
      skipAttempt: 1,
      maxSkipAttempts: 2,
    });
    expect(decision).toEqual({
      action: 'defer',
      reason: 'analysis_pending',
      providerReason: 'pending_timeout',
    });
  });

  it('continues on clean, needs_fixes, and not_configured', () => {
    expect(
      evaluateExternalReviewStopRule({
        result: { status: 'clean', blockers: [], advisories: [] },
        skipAttempt: 1,
        maxSkipAttempts: 2,
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
      }).action,
    ).toBe('continue');

    expect(
      evaluateExternalReviewStopRule({
        result: { status: 'skipped', reason: 'not_configured' },
        skipAttempt: 1,
        maxSkipAttempts: 2,
      }).action,
    ).toBe('continue');
  });

  it('retries when skipped under the attempt budget', () => {
    expect(
      evaluateExternalReviewStopRule({
        result: { status: 'skipped', reason: 'unavailable' },
        skipAttempt: 1,
        maxSkipAttempts: 2,
      }),
    ).toEqual({ action: 'retry', skipAttempt: 1 });
  });

  it('escalates on repeated skip when attempt budget is exhausted', () => {
    const decision = evaluateExternalReviewStopRule({
      result: { status: 'skipped', reason: 'unavailable' },
      skipAttempt: 2,
      maxSkipAttempts: 2,
    });
    expect(decision).toMatchObject({
      action: 'escalate',
      reason: 'external_repeated_skip',
      skipAttempt: 2,
    });
  });
});
