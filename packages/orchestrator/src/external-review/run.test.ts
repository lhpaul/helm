import { describe, expect, it } from 'vitest';
import type { Product } from '@helm/shared';
import { parsePullRequestRef, runExternalReviewIfConfigured } from './run.js';

const baseProduct = {
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
  },
} satisfies Product;

const PR_URL = 'https://github.com/o/r/pull/42';

describe('parsePullRequestRef', () => {
  it('parses a standard GitHub PR URL', () => {
    expect(parsePullRequestRef(PR_URL)).toEqual({
      owner: 'o',
      repo: 'r',
      prNumber: 42,
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parsePullRequestRef('https://gitlab.com/o/r/-/merge_requests/1')).toBeNull();
  });

  it('returns null for malformed GitHub URLs', () => {
    expect(parsePullRequestRef('https://github.com/o/r/issues/42')).toBeNull();
  });
});

describe('runExternalReviewIfConfigured', () => {
  it('skips when review.external.provider is omitted', async () => {
    await expect(runExternalReviewIfConfigured(baseProduct, PR_URL)).resolves.toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
  });

  it('skips when code_repos is empty', async () => {
    const product: Product = {
      ...baseProduct,
      code_repos: [],
      review: { external: { provider: 'haystack' } },
    };
    await expect(runExternalReviewIfConfigured(product, PR_URL)).resolves.toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
  });

  it('skips when the PR URL cannot be parsed', async () => {
    const product: Product = {
      ...baseProduct,
      review: { external: { provider: 'haystack' } },
    };
    await expect(runExternalReviewIfConfigured(product, 'not-a-url')).resolves.toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
  });

  it('returns not_implemented for haystack until CLI integration lands', async () => {
    const product: Product = {
      ...baseProduct,
      review: { external: { provider: 'haystack' } },
    };
    await expect(runExternalReviewIfConfigured(product, PR_URL)).resolves.toEqual({
      status: 'skipped',
      reason: 'not_implemented',
    });
  });
});
