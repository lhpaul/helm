import { describe, expect, it } from 'vitest';
import { evaluateExternalReviewStopRule } from './external-stop-rule.js';
import { parseLocalAiReview } from '../external-review/local-ai-reviewer/adapter.js';

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
      externalReason: 'unavailable',
    });
  });

  it('names the provider reason in a repeated-skip escalation', () => {
    // Every unavailability reads as `unavailable` on its own; the human who
    // receives the escalation has to tell a quota stop from a misconfiguration.
    const decision = evaluateExternalReviewStopRule({
      result: { status: 'skipped', reason: 'unavailable', providerReason: 'usage_limit' },
      skipAttempt: 2,
      maxSkipAttempts: 2,
    });

    expect(decision).toMatchObject({
      action: 'escalate',
      reason: 'external_repeated_skip',
      externalReason: 'unavailable: usage_limit',
    });
    if (decision.action === 'escalate') {
      expect(decision.message).toContain('unavailable: usage_limit');
    }
  });

  describe('local-ai-reviewer companion failures (#134)', () => {
    const ctx = {
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      prUrl: 'https://github.com/o/r/pull/1',
      defaultBranch: 'main',
      targetRevision: 'a'.repeat(40),
    };
    const companion = (reason: string) =>
      parseLocalAiReview(
        { stdout: `RESULT=escalate\nREASON=${reason}\n`, exitCode: 2, evidence: null },
        ctx,
      );

    it('escalates a deterministic reason on the first attempt, without retry', () => {
      expect(
        evaluateExternalReviewStopRule({
          result: companion('review_contract_missing'),
          skipAttempt: 1,
          maxSkipAttempts: 2,
        }),
      ).toEqual({
        action: 'escalate',
        reason: 'external_escalate',
        message: 'External review escalated: review_contract_missing',
        skipAttempt: 1,
        externalReason: 'review_contract_missing',
      });
    });

    it('retries a transient reason, then escalates naming it', () => {
      const result = companion('quota_exhausted');
      expect(
        evaluateExternalReviewStopRule({ result, skipAttempt: 1, maxSkipAttempts: 2 }),
      ).toEqual({ action: 'retry', skipAttempt: 1 });
      expect(
        evaluateExternalReviewStopRule({ result, skipAttempt: 2, maxSkipAttempts: 2 }),
      ).toMatchObject({
        action: 'escalate',
        reason: 'external_repeated_skip',
        externalReason: 'unavailable: quota_exhausted',
      });
    });
  });
});
