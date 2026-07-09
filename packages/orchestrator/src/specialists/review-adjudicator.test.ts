import { describe, expect, it } from 'vitest';

import { buildReviewAdjudicatorParams } from './review-adjudicator.js';
import type { Product } from '@helm/shared';

const product = {
  helm_version: '0' as const,
  product: { slug: 'test', name: 'Test' },
  issue_tracker: { provider: 'github_projects' as const, org: 'o', project_number: 1 },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' as const }],
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
  workflow: {
    stages_enabled: ['code-review' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
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
    'review-adjudicator': { runtime: 'claude_code' as const, model: 'm' },
  },
} satisfies Product;

describe('buildReviewAdjudicatorParams', () => {
  it('includes reviewer bodies and forbids pushing changes', () => {
    const findings = new Map([['code', '# Code Review\n\n## Status\nCHANGES_REQUESTED'] as const]);

    const params = buildReviewAdjudicatorParams(
      'LEA-192',
      product,
      '/tmp/ws',
      'https://github.com/o/r/pull/1',
      findings,
      { spec: '# Spec\n\nVacate literally on empty search.' },
    );

    expect(params.specialistId).toBe('review-adjudicator');
    expect(params.prompt).toContain('Code Review');
    expect(params.prompt).toContain('Vacate literally on empty search');
    expect(params.prompt).toContain('Do NOT modify source files');
    expect(params.permissionMode).toBe('default');
  });

  it('does not duplicate external blockers when they are embedded in code findings', () => {
    const externalBody = '- **HIGH**: Missing guard';
    const findings = new Map([
      ['code', ['## External review blockers', '', externalBody].join('\n')] as const,
    ]);

    const params = buildReviewAdjudicatorParams(
      'LEA-192',
      product,
      '/tmp/ws',
      'https://github.com/o/r/pull/1',
      findings,
    );

    const matches = params.prompt.match(/## External review blockers/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(params.prompt).toContain(externalBody);
  });

  it('throws when review-adjudicator is not configured', () => {
    const { 'review-adjudicator': _reviewAdjudicator, ...specialists } = product.specialists;
    void _reviewAdjudicator;
    const withoutAdjudicator = { ...product, specialists };

    expect(() =>
      buildReviewAdjudicatorParams(
        'LEA-192',
        withoutAdjudicator,
        '/tmp/ws',
        'https://github.com/o/r/pull/1',
        new Map(),
      ),
    ).toThrow(/not configured/);
  });
});
