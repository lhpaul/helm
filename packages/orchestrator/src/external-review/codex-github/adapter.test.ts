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
import type { CodexGitHubReviewPayload, CodexGitHubRootCommentPayload } from './types.js';

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

/**
 * helm#96: Codex's trusted clean terminal signal. Codex does not always publish
 * a submitted review, so a run that finds nothing has to be readable from the
 * SHA-pinned root comment it does publish — without ever letting an
 * acknowledgement, a stale summary, or a quota notice read as clean.
 */
describe('codex-github root-comment evidence', () => {
  const config = resolveCodexGitHubReviewConfig(baseProduct);
  const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function rootComment(body: string, createdAt: string, id = 1): CodexGitHubRootCommentPayload {
    return {
      id,
      node_id: `IC_${id}`,
      body,
      created_at: createdAt,
      user: { login: 'chatgpt-codex-connector[bot]' },
    };
  }

  it('reads a SHA-pinned clean summary as clean', () => {
    expect(
      normalizeCodexGitHubReviewPayload(loadFixture('root-comment-clean.json'), config),
    ).toEqual({ status: 'clean', blockers: [], advisories: [] });
  });

  it('accepts an abbreviated SHA in the marker and blocks on the finding', () => {
    const result = normalizeCodexGitHubReviewPayload(
      loadFixture('root-comment-blocking.json'),
      config,
    );

    expect(result.status).toBe('needs_fixes');
    if (result.status === 'needs_fixes') {
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.severity).toBe('high');
      expect(result.blockers[0]?.blocking).toBe(true);
    }
  });

  it('keeps deferring on a stale summary and an acknowledgement-only comment', () => {
    expect(
      normalizeCodexGitHubReviewPayload(loadFixture('root-comment-stale.json'), config),
    ).toEqual({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'codex-github review pending',
    });
  });

  it('reports a missing Codex environment as unavailable, not clean', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        loadFixture('root-comment-environment-missing.json'),
        config,
      ),
    ).toEqual({
      status: 'skipped',
      reason: 'unavailable',
      providerReason: 'environment_missing',
    });
  });

  it('reports an exhausted usage limit as unavailable, not clean', () => {
    expect(
      normalizeCodexGitHubReviewPayload(loadFixture('root-comment-usage-limit.json'), config),
    ).toEqual({ status: 'skipped', reason: 'unavailable', providerReason: 'usage_limit' });
  });

  it('treats a SHA-pinned response it cannot parse as unavailable', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        {
          targetRevision: HEAD,
          reviewPending: true,
          rootComments: [
            rootComment(
              `Reviewed commit: \`${HEAD}\`\n\nSee the attached trace.`,
              '2026-08-17T12:00:00Z',
            ),
          ],
        },
        config,
      ),
    ).toEqual({
      status: 'skipped',
      reason: 'unavailable',
      providerReason: 'unrecognized_terminal_response',
    });
  });

  it('lets a strictly newer clean summary supersede an environment error', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        {
          targetRevision: HEAD,
          reviewPending: true,
          rootComments: [
            rootComment(
              'To use Codex here, create an environment for this repo.',
              '2026-08-17T12:00:00Z',
              1,
            ),
            rootComment(
              `Reviewed commit: \`${HEAD}\`\n\nNo issues found.`,
              '2026-08-17T12:05:00Z',
              2,
            ),
          ],
        },
        config,
      ),
    ).toEqual({ status: 'clean', blockers: [], advisories: [] });
  });

  it('keeps an environment error when only an acknowledgement follows it', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        {
          targetRevision: HEAD,
          reviewPending: true,
          rootComments: [
            rootComment(
              'To use Codex here, create an environment for this repo.',
              '2026-08-17T12:00:00Z',
              1,
            ),
            rootComment('Working on it.', '2026-08-17T12:30:00Z', 2),
          ],
        },
        config,
      ),
    ).toEqual({
      status: 'skipped',
      reason: 'unavailable',
      providerReason: 'environment_missing',
    });
  });

  /**
   * The quota notice stays on the PR forever. Treating it as a sticky flag meant
   * every later poll re-asserted it, so a PR that once hit quota could never
   * read clean from root-comment evidence again — it ground on to
   * `external_repeated_skip` long after the quota reset.
   */
  it('lets a newer clean summary supersede an older usage-limit notice', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        {
          targetRevision: HEAD,
          reviewPending: true,
          rootComments: [
            rootComment('You have reached your Codex usage limits.', '2026-08-17T12:00:00Z', 1),
            rootComment(
              `Reviewed commit: \`${HEAD}\`\n\nNo issues found.`,
              '2026-08-17T13:00:00Z',
              2,
            ),
          ],
        },
        config,
      ),
    ).toEqual({ status: 'clean', blockers: [], advisories: [] });
  });

  it('keeps the usage limit when it is the newest evidence', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        {
          targetRevision: HEAD,
          reviewPending: true,
          rootComments: [
            rootComment(
              `Reviewed commit: \`${HEAD}\`\n\nNo issues found.`,
              '2026-08-17T12:00:00Z',
              1,
            ),
            rootComment('You have reached your Codex usage limits.', '2026-08-17T13:00:00Z', 2),
          ],
        },
        config,
      ),
    ).toEqual({ status: 'skipped', reason: 'unavailable', providerReason: 'usage_limit' });
  });

  it('lets an older blocking finding win over a newer usage-limit notice', () => {
    const result = normalizeCodexGitHubReviewPayload(
      {
        targetRevision: HEAD,
        reviewPending: true,
        rootComments: [
          rootComment(
            `Reviewed commit: \`${HEAD}\`\n\n**[P0]** The migration drops the column before backfilling it.`,
            '2026-08-17T12:00:00Z',
            1,
          ),
          rootComment('You have reached your Codex usage limits.', '2026-08-17T12:30:00Z', 2),
        ],
      },
      config,
    );

    expect(result.status).toBe('needs_fixes');
  });

  it('prefers the non-clean side when a review and a summary share a timestamp', () => {
    const result = normalizeCodexGitHubReviewPayload(
      {
        targetRevision: HEAD,
        review: {
          id: 1,
          state: 'COMMENTED',
          body: 'Codex Review',
          commit_id: HEAD,
          submitted_at: '2026-08-17T12:00:00Z',
        },
        rootComments: [
          rootComment(
            `Reviewed commit: \`${HEAD}\`\n\nSee the attached trace.`,
            '2026-08-17T12:00:00Z',
          ),
        ],
      },
      config,
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'unavailable',
      providerReason: 'unrecognized_terminal_response',
    });
  });

  it('does not let a clean review paper over a failed root-comment read', () => {
    expect(
      normalizeCodexGitHubReviewPayload(
        {
          targetRevision: HEAD,
          rootCommentsUnavailable: true,
          review: {
            id: 1,
            state: 'COMMENTED',
            body: 'Codex Review: no issues found.',
            commit_id: HEAD,
            submitted_at: '2026-08-17T12:00:00Z',
          },
        },
        config,
      ),
    ).toEqual({
      status: 'skipped',
      reason: 'unavailable',
      providerReason: 'root_comments_unavailable',
    });
  });

  it('lands a P3-only summary on the advisory list instead of blocking', () => {
    const result = normalizeCodexGitHubReviewPayload(
      {
        targetRevision: HEAD,
        reviewPending: true,
        rootComments: [
          rootComment(
            `Reviewed commit: \`${HEAD}\`\n\n**[P3] Nit:** stale wording in the table.`,
            '2026-08-17T12:00:00Z',
          ),
        ],
      },
      config,
    );

    expect(result.status).toBe('clean');
    if (result.status === 'clean') {
      expect(result.advisories).toHaveLength(1);
      expect(result.advisories[0]?.severity).toBe('low');
    }
  });

  it('keeps the review advisories when a clean summary outranks a clean review', () => {
    const result = normalizeCodexGitHubReviewPayload(
      {
        targetRevision: HEAD,
        review: {
          id: 1,
          state: 'COMMENTED',
          body: 'Codex Review',
          commit_id: HEAD,
          submitted_at: '2026-08-17T12:00:00Z',
        },
        reviewComments: [
          { id: 5, path: 'docs/product-config.md', line: 12, body: '**[P3] Nit:** stale wording.' },
        ],
        rootComments: [
          rootComment(`Reviewed commit: \`${HEAD}\`\n\nNo issues found.`, '2026-08-17T12:05:00Z'),
        ],
      },
      config,
    );

    expect(result.status).toBe('clean');
    if (result.status === 'clean') {
      expect(result.advisories).toHaveLength(1);
      expect(result.advisories[0]?.severity).toBe('low');
    }
  });

  it('still surfaces blockers when the root-comment read failed', () => {
    const result = normalizeCodexGitHubReviewPayload(
      {
        targetRevision: HEAD,
        rootCommentsUnavailable: true,
        review: {
          id: 1,
          state: 'CHANGES_REQUESTED',
          body: '[P0] boom',
          commit_id: HEAD,
          submitted_at: '2026-08-17T12:00:00Z',
        },
      },
      config,
    );

    expect(result.status).toBe('needs_fixes');
  });
});
