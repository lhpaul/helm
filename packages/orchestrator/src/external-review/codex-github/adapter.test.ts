import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ExternalReviewContext } from '../types.js';
import {
  CodexGitHubExternalReviewAdapter,
  normalizeCodexGitHubReviewPayload,
  resolveCodexGitHubReviewConfig,
} from './adapter.js';
import type { CodexGitHubReviewPayload } from './types.js';

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
  review: {
    external: {
      provider: 'codex-github' as const,
      codex_github: {
        trusted_identities: ['chatgpt-codex-connector[bot]'],
        check_names: ['Codex'],
        blocking_severities: ['critical', 'high'],
      },
    },
  },
} satisfies Product;

const ctx: ExternalReviewContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 42,
  prUrl: 'https://github.com/o/r/pull/42',
  defaultBranch: 'main',
};

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): CodexGitHubReviewPayload {
  return JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', name), 'utf8'),
  ) as CodexGitHubReviewPayload;
}

function withDeferWhenPending(deferWhenPending: boolean): Product {
  return {
    ...baseProduct,
    review: {
      ...baseProduct.review,
      external: { ...baseProduct.review.external, defer_when_pending: deferWhenPending },
    },
  };
}

describe('CodexGitHubExternalReviewAdapter', () => {
  it('normalizes a submitted review without findings to clean', async () => {
    const adapter = new CodexGitHubExternalReviewAdapter(baseProduct, {
      loadCodexGitHubReview: vi.fn(() => loadFixture('review-clean.json')),
    });

    await expect(adapter.reviewPullRequest(ctx)).resolves.toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
  });

  it('skips when no loader is wired', async () => {
    const adapter = new CodexGitHubExternalReviewAdapter(baseProduct);
    await expect(adapter.reviewPullRequest(ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
  });

  it('defers while no review has been submitted for the revision', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('review-pending.json'),
      resolveCodexGitHubReviewConfig(baseProduct),
    );

    expect(result).toEqual({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'codex-github review pending',
    });
  });

  it('names the in-flight check run in the pending reason', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('check-run-pending.json'),
      resolveCodexGitHubReviewConfig(baseProduct),
    );

    expect(result).toEqual({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'codex-github check_run in_progress',
    });
  });

  it('escalates instead of deferring when defer_when_pending is false', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('review-pending.json'),
      resolveCodexGitHubReviewConfig(withDeferWhenPending(false)),
    );

    expect(result).toEqual({ status: 'escalate', reason: 'codex-github review pending' });
  });

  it('maps unresolved P1 comments to blockers and P3 comments to advisories', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('review-comment-blocking.json'),
      resolveCodexGitHubReviewConfig(baseProduct),
    );

    expect(result.status).toBe('needs_fixes');
    if (result.status === 'needs_fixes') {
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.path).toBe('apps/api/src/routes/webhooks.ts');
      expect(result.blockers[0]?.severity).toBe('high');
      expect(result.blockers[0]?.id).toMatch(/^codex-github:/);
      expect(result.advisories).toHaveLength(1);
      expect(result.advisories[0]?.severity).toBe('low');
    }
  });

  it('does not resurrect a resolved thread comment that also arrives via REST', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('review-comment-blocking.json'),
      resolveCodexGitHubReviewConfig(baseProduct),
    );

    if (result.status !== 'needs_fixes') throw new Error(`unexpected status ${result.status}`);
    const summaries = [...result.blockers, ...result.advisories].map((f) => f.summary);
    expect(summaries.some((summary) => summary.includes('Ledger write is not clamped'))).toBe(
      false,
    );
  });

  it('blocks on CHANGES_REQUESTED even without inline findings', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('review-changes-requested.json'),
      resolveCodexGitHubReviewConfig(baseProduct),
    );

    expect(result.status).toBe('needs_fixes');
    if (result.status === 'needs_fixes') {
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.severity).toBe('critical');
      expect(result.blockers[0]?.blocking).toBe(true);
    }
  });

  it('treats an unlabeled comment as high, not medium', () => {
    const result = normalizeCodexGitHubReviewPayload(
      {
        review: { state: 'COMMENTED', commit_id: 'abc1234', body: 'Codex Review' },
        reviewComments: [
          { id: 1, path: 'a.ts', line: 3, body: 'This drops the error before it is logged.' },
        ],
      },
      resolveCodexGitHubReviewConfig(baseProduct),
    );

    expect(result.status).toBe('needs_fixes');
    if (result.status === 'needs_fixes') {
      expect(result.blockers[0]?.severity).toBe('high');
    }
  });

  it('escalates on loader error and skips a dismissed review', () => {
    const config = resolveCodexGitHubReviewConfig(baseProduct);

    expect(
      normalizeCodexGitHubReviewPayload({ error: 'github_review_fetch_failed' }, config),
    ).toEqual({ status: 'escalate', reason: 'codex-github github_review_fetch_failed' });
    expect(normalizeCodexGitHubReviewPayload({ unavailable: true }, config)).toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
    expect(
      normalizeCodexGitHubReviewPayload(
        { review: { state: 'DISMISSED', commit_id: 'abc1234' } },
        config,
      ),
    ).toEqual({ status: 'skipped', reason: 'unavailable', providerReason: 'review_dismissed' });
  });
});
