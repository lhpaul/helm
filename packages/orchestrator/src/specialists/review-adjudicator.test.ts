import { describe, expect, it, vi } from 'vitest';

import {
  buildReviewAdjudicatorParams,
  handleReviewAdjudicatorResult,
} from './review-adjudicator.js';
import type { Product } from '@helm/shared';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('./pr-helpers.js', () => ({
  postPRComment: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { postPRComment } from './pr-helpers.js';

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
    expect(params.permissionMode).toBe('acceptEdits');
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

describe('handleReviewAdjudicatorResult', () => {
  it('falls back to HUMAN_REQUIRED when the adjudication artifact is missing', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    vi.mocked(postPRComment).mockResolvedValue(undefined);

    const result = await handleReviewAdjudicatorResult(
      'LEA-192',
      {
        status: 'done',
        totalCostUsd: 0,
        durationMs: 1,
        messages: [],
      },
      '/tmp/ws',
      'https://github.com/o/r/pull/1',
      'token',
    );

    expect(result).toMatchObject({
      status: 'done',
      commentPosted: true,
      parsed: { status: 'HUMAN_REQUIRED' },
    });
  });

  it('surfaces non-ENOENT read failures instead of masking them', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    await expect(
      handleReviewAdjudicatorResult(
        'LEA-192',
        {
          status: 'done',
          totalCostUsd: 0,
          durationMs: 1,
          messages: [],
        },
        '/tmp/ws',
        'https://github.com/o/r/pull/1',
        'token',
      ),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('redacts the GitHub token when postPRComment fails', async () => {
    const githubToken = 'ghp_super_secret_token_value';
    vi.mocked(readFile).mockResolvedValue(
      [
        '# Review Adjudication: LEA-192',
        '',
        '## Status',
        'AUTO_REMEDIATE',
        '',
        '## Unified remediation plan',
        'Apply the fix.',
      ].join('\n'),
    );
    vi.mocked(postPRComment).mockRejectedValue(
      new Error(`401 Bad credentials for token ${githubToken}`),
    );

    const result = await handleReviewAdjudicatorResult(
      'LEA-192',
      {
        status: 'done',
        totalCostUsd: 0,
        durationMs: 1,
        messages: [],
      },
      '/tmp/ws',
      'https://github.com/o/r/pull/1',
      githubToken,
    );

    expect(result).toMatchObject({
      status: 'error',
      commentPosted: false,
      parsed: { status: 'AUTO_REMEDIATE' },
    });
    expect(result.error).toContain('Failed to post adjudication comment');
    expect(result.error).not.toContain(githubToken);
  });
});
