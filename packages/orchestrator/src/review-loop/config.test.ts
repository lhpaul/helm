import { describe, expect, it } from 'vitest';
import { ProductSchema } from '@helm/shared';

import { resolveReviewLoopConfig } from './config.js';

const baseSpecialists = {
  'spec-writer': { runtime: 'claude_code' as const, model: 'm' },
  'plan-writer': { runtime: 'claude_code' as const, model: 'm' },
  implementer: { runtime: 'claude_code' as const, model: 'm' },
  'code-reviewer': { runtime: 'claude_code' as const, model: 'm' },
  'security-reviewer': { runtime: 'claude_code' as const, model: 'm' },
  'test-reviewer': { runtime: 'claude_code' as const, model: 'm' },
  'spec-remediator': { runtime: 'claude_code' as const, model: 'm' },
  'plan-remediator': { runtime: 'claude_code' as const, model: 'm' },
  'code-remediator': { runtime: 'claude_code' as const, model: 'm' },
};

const makeRawProduct = (overrides: Record<string, unknown> = {}) => ({
  helm_version: '0',
  product: { slug: 'test-product', name: 'Test Product' },
  issue_tracker: { provider: 'github_projects', org: 'test-org', project_number: 1 },
  code_repos: [{ url: 'https://github.com/test-org/test', default_branch: 'main', role: 'app' }],
  knowledge_repo: { url: 'https://github.com/test-org/knowledge', default_branch: 'main' },
  workflow: { stages_enabled: ['code-review'] },
  specialists: baseSpecialists,
  ...overrides,
});

describe('resolveReviewLoopConfig (ADR-036/037)', () => {
  it('enables adjudication only when review-adjudicator is configured', () => {
    const withAdjudicator = ProductSchema.parse(
      makeRawProduct({
        specialists: {
          ...baseSpecialists,
          'review-adjudicator': { runtime: 'claude_code', model: 'm' },
        },
      }),
    );
    expect(resolveReviewLoopConfig(withAdjudicator).adjudicationEnabled).toBe(true);

    const withoutAdjudicator = ProductSchema.parse(makeRawProduct());
    expect(resolveReviewLoopConfig(withoutAdjudicator).adjudicationEnabled).toBe(false);
  });

  it('honours explicit adjudication disable even when review-adjudicator exists', () => {
    const product = ProductSchema.parse(
      makeRawProduct({
        specialists: {
          ...baseSpecialists,
          'review-adjudicator': { runtime: 'claude_code', model: 'm' },
        },
        review: { loop: { adjudication: { enabled: false } } },
      }),
    );
    expect(resolveReviewLoopConfig(product).adjudicationEnabled).toBe(false);
  });
});

describe('ProductSchema adjudication invariants (validate-runtime-config-invariants)', () => {
  it('rejects enabled adjudication without review-adjudicator specialist', () => {
    const result = ProductSchema.safeParse(
      makeRawProduct({ review: { loop: { adjudication: { enabled: true } } } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['review', 'loop', 'adjudication', 'enabled']);
    }
  });
});
