import { describe, expect, it } from 'vitest';
import type { ReviewerResult } from '../specialists/reviewer-fanout.js';
import { resolveReviewLoopConfig } from './config.js';
import { countBlockingFindings, evaluateStopRule, nextNoProgressStreak } from './stop-rule.js';
import type { Product } from '@helm/shared';

const baseProduct = {
  helm_version: '0' as const,
  product: { slug: 'test', name: 'Test' },
  issue_tracker: {
    provider: 'github_projects' as const,
    org: 'o',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' as const }],
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
  workflow: {
    stages_enabled: ['code-review' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
    readiness_gate: 'skip' as const,
    final_stage: 'released' as const,
  },
  specialists: {
    'spec-writer': { runtime: 'claude_code' as const, model: 'm' },
    'plan-writer': { runtime: 'claude_code' as const, model: 'm' },
    implementer: { runtime: 'claude_code' as const, model: 'm' },
    'code-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'security-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'test-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'spec-remediator': { runtime: 'claude_code' as const, model: 'm' },
    'plan-remediator': { runtime: 'claude_code' as const, model: 'm' },
    'code-remediator': { runtime: 'claude_code' as const, model: 'm' },
  },
} satisfies Product;

function makeResult(findings?: ReviewerResult['findings']): ReviewerResult {
  return {
    kind: 'code',
    status: 'done',
    costUsd: 0,
    durationMs: 0,
    commentPosted: true,
    findings,
  };
}

describe('resolveReviewLoopConfig', () => {
  it('returns ADR-036 defaults when review is omitted', () => {
    expect(resolveReviewLoopConfig(baseProduct)).toEqual({
      maxCycles: 5,
      maxCyclesCumulative: 15,
      noProgressCycles: 2,
      adjudicationEnabled: false,
      remediateSeverity: 'critical_high',
      earlyLoopEnabled: false,
    });
  });

  it('derives the cumulative budget from max_cycles when unset (ADR-042)', () => {
    const product: Product = {
      ...baseProduct,
      review: { loop: { max_cycles: 4, remediate_severity: 'critical_high' } },
    };
    expect(resolveReviewLoopConfig(product).maxCyclesCumulative).toBe(12);
  });

  it('reads an explicit max_cycles_cumulative override', () => {
    const product: Product = {
      ...baseProduct,
      review: {
        loop: { max_cycles: 4, max_cycles_cumulative: 6, remediate_severity: 'critical_high' },
      },
    };
    expect(resolveReviewLoopConfig(product).maxCyclesCumulative).toBe(6);
  });

  it('enables adjudication when review-adjudicator specialist is configured', () => {
    const product: Product = {
      ...baseProduct,
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    expect(resolveReviewLoopConfig(product).adjudicationEnabled).toBe(true);
  });

  it('reads review.loop overrides', () => {
    const product: Product = {
      ...baseProduct,
      review: {
        loop: {
          max_cycles: 3,
          adjudication: { enabled: false },
          stop_rule: { no_progress_cycles: 4 },
          remediate_severity: 'critical_high',
        },
      },
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    expect(resolveReviewLoopConfig(product)).toEqual({
      maxCycles: 3,
      maxCyclesCumulative: 9,
      noProgressCycles: 4,
      adjudicationEnabled: false,
      remediateSeverity: 'critical_high',
      earlyLoopEnabled: false,
    });
  });
});

describe('countBlockingFindings', () => {
  it('sums critical and high across reviewers', () => {
    const results = [
      makeResult({ critical: 1, high: 0, medium: 0, low: 0, info: 0 }),
      makeResult({ critical: 0, high: 2, medium: 5, low: 0, info: 0 }),
    ];
    expect(countBlockingFindings(results)).toBe(3);
  });
});

describe('stop rule helpers', () => {
  it('escalates at max_cycles', () => {
    expect(
      evaluateStopRule({ cycle: 5, maxCycles: 5, noProgressCycles: 2, noProgressStreak: 0 }),
    ).toEqual({ escalate: true, reason: 'max_cycles' });
  });

  it('escalates when the cumulative budget is exhausted, even on cycle 1 (ADR-042)', () => {
    expect(
      evaluateStopRule({
        cycle: 1,
        maxCycles: 5,
        noProgressCycles: 2,
        noProgressStreak: 0,
        cumulativeCycle: 15,
        maxCyclesCumulative: 15,
      }),
    ).toEqual({ escalate: true, reason: 'max_cycles_cumulative' });
  });

  it('prefers the cumulative reason when both budgets are exhausted', () => {
    expect(
      evaluateStopRule({
        cycle: 5,
        maxCycles: 5,
        noProgressCycles: 2,
        noProgressStreak: 0,
        cumulativeCycle: 20,
        maxCyclesCumulative: 15,
      }),
    ).toEqual({ escalate: true, reason: 'max_cycles_cumulative' });
  });

  it('does not escalate while the cumulative budget has room', () => {
    expect(
      evaluateStopRule({
        cycle: 1,
        maxCycles: 5,
        noProgressCycles: 2,
        noProgressStreak: 0,
        cumulativeCycle: 14,
        maxCyclesCumulative: 15,
      }),
    ).toEqual({ escalate: false });
  });

  it('ignores the cumulative rule when the caller does not track it', () => {
    expect(
      evaluateStopRule({ cycle: 1, maxCycles: 5, noProgressCycles: 2, noProgressStreak: 0 }),
    ).toEqual({ escalate: false });
  });

  it('escalates on no_progress streak', () => {
    expect(
      evaluateStopRule({ cycle: 2, maxCycles: 5, noProgressCycles: 2, noProgressStreak: 2 }),
    ).toEqual({ escalate: true, reason: 'no_progress' });
  });

  it('tracks no-progress streak against best-so-far blockers (ADR-037)', () => {
    expect(nextNoProgressStreak(null, 3, 0)).toBe(0);
    expect(nextNoProgressStreak(3, 3, 0)).toBe(1);
    expect(nextNoProgressStreak(3, 2, 1)).toBe(0);
    expect(nextNoProgressStreak(2, 4, 1)).toBe(2);
    // Oscillation: improved to 0, then regressed to 2
    expect(nextNoProgressStreak(0, 2, 0)).toBe(1);
  });

  it('resets streak when sticky remaining drops even if blocker count is flat', () => {
    expect(nextNoProgressStreak(3, 3, 2, 2, 1)).toBe(0);
    expect(nextNoProgressStreak(3, 3, 2, 2, 2)).toBe(3);
  });
});
