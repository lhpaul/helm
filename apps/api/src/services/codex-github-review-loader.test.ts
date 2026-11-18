import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import { createGitHubCodexGitHubReviewLoader } from './codex-github-review-loader.js';

const product = {
  product: { slug: 'test', name: 'Test' },
  review: {
    external: {
      provider: 'codex-github',
      codex_github: {
        trusted_identities: ['chatgpt-codex-connector[bot]'],
        check_names: ['Codex'],
        blocking_severities: ['critical', 'high'],
      },
    },
  },
} as Product;

const ctx = {
  owner: 'o',
  repo: 'r',
  prNumber: 42,
  prUrl: 'https://github.com/o/r/pull/42',
  defaultBranch: 'main',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function threadsResponse(nodes: unknown[]): Response {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  });
}

describe('createGitHubCodexGitHubReviewLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the latest trusted review for the target revision with its comments', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl === 'https://api.github.com/graphql') {
        return threadsResponse([
          {
            id: 'PRRT_1',
            isResolved: false,
            path: 'a.ts',
            line: 10,
            comments: {
              nodes: [
                {
                  databaseId: 1,
                  id: 'PRRC_1',
                  path: 'a.ts',
                  line: 10,
                  body: '[P1] boom',
                  author: { login: 'chatgpt-codex-connector[bot]' },
                  pullRequestReview: { databaseId: 3 },
                },
              ],
            },
          },
          {
            id: 'PRRT_2',
            isResolved: true,
            path: 'b.ts',
            line: 20,
            comments: {
              nodes: [
                {
                  databaseId: 2,
                  id: 'PRRC_2',
                  path: 'b.ts',
                  line: 20,
                  body: '[P1] already fixed',
                  author: { login: 'chatgpt-codex-connector[bot]' },
                  pullRequestReview: { databaseId: 3 },
                },
              ],
            },
          },
        ]);
      }
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) {
        return jsonResponse([
          {
            id: 1,
            state: 'COMMENTED',
            commit_id: 'abc1234',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'stale reviewer',
            user: { login: 'someone-else' },
          },
          {
            id: 2,
            state: 'COMMENTED',
            commit_id: 'older000',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'previous revision',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
          {
            id: 3,
            state: 'CHANGES_REQUESTED',
            commit_id: 'abc1234',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'Codex Review',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
        ]);
      }
      if (requestUrl.includes('/pulls/42/comments')) {
        return jsonResponse([
          {
            id: 1,
            node_id: 'PRRC_1',
            path: 'a.ts',
            line: 10,
            body: '[P1] boom',
            user: { login: 'chatgpt-codex-connector[bot]' },
            pull_request_review_id: 3,
          },
          {
            id: 2,
            node_id: 'PRRC_2',
            path: 'b.ts',
            line: 20,
            body: '[P1] already fixed',
            user: { login: 'chatgpt-codex-connector[bot]' },
            pull_request_review_id: 3,
          },
          {
            id: 3,
            node_id: 'PRRC_3',
            path: 'c.ts',
            line: 30,
            body: 'human nit',
            user: { login: 'lhpaul' },
            pull_request_review_id: 3,
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await createGitHubCodexGitHubReviewLoader({
      product,
      githubToken: 't',
    })(ctx);

    expect(payload?.review?.id).toBe(3);
    expect(payload?.review?.state).toBe('CHANGES_REQUESTED');
    // The resolved thread's comment is dropped from the REST list, and the
    // untrusted human comment never enters the payload.
    expect(payload?.reviewComments?.map((comment) => comment.id)).toEqual([1]);
    expect(payload?.reviewThreads).toHaveLength(1);
    expect(payload?.reviewThreads?.[0]?.id).toBe('PRRT_1');
  });

  it('drops inline findings from an earlier review on the same PR', async () => {
    // After a remediation push Codex reviews the new SHA, but its unresolved
    // threads from the previous SHA are still returned by both endpoints.
    // Combining them with this revision's clean verdict would block forever.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl === 'https://api.github.com/graphql') {
        return threadsResponse([
          {
            id: 'PRRT_OLD',
            isResolved: false,
            path: 'a.ts',
            line: 10,
            comments: {
              nodes: [
                {
                  databaseId: 1,
                  id: 'PRRC_OLD',
                  path: 'a.ts',
                  line: 10,
                  body: '[P0] fixed on the previous push',
                  author: { login: 'chatgpt-codex-connector[bot]' },
                  pullRequestReview: { databaseId: 11 },
                },
              ],
            },
          },
        ]);
      }
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) {
        return jsonResponse([
          {
            id: 11,
            state: 'CHANGES_REQUESTED',
            commit_id: 'old0000',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'previous revision',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
          {
            id: 12,
            state: 'COMMENTED',
            commit_id: 'abc1234',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'No issues found.',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
        ]);
      }
      if (requestUrl.includes('/pulls/42/comments')) {
        return jsonResponse([
          {
            id: 1,
            node_id: 'PRRC_OLD',
            path: 'a.ts',
            line: 10,
            body: '[P0] fixed on the previous push',
            user: { login: 'chatgpt-codex-connector[bot]' },
            pull_request_review_id: 11,
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await createGitHubCodexGitHubReviewLoader({
      product,
      githubToken: 't',
    })(ctx);

    expect(payload?.review?.id).toBe(12);
    expect(payload?.reviewComments).toEqual([]);
    expect(payload?.reviewThreads).toEqual([]);
  });

  it('reports reviewPending with the in-flight Codex check run when no review matches', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) return jsonResponse([]);
      if (requestUrl.includes('/commits/abc1234/check-runs')) {
        return jsonResponse({
          check_runs: [
            { name: 'Codex', status: 'in_progress', app: { slug: 'impostor' } },
            {
              name: 'Codex',
              status: 'in_progress',
              conclusion: null,
              head_sha: 'abc1234',
              app: { slug: 'chatgpt-codex-connector' },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await createGitHubCodexGitHubReviewLoader({
      product,
      githubToken: 't',
    })(ctx);

    expect(payload).toEqual({
      targetRevision: 'abc1234',
      rootComments: [],
      reviewPending: true,
      checkRun: {
        name: 'Codex',
        status: 'in_progress',
        conclusion: null,
        head_sha: 'abc1234',
      },
    });
  });

  it('does not relax review-author matching to the un-suffixed login', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) {
        return jsonResponse([
          {
            id: 9,
            state: 'CHANGES_REQUESTED',
            commit_id: 'abc1234',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'impersonation attempt',
            // A human may hold the un-suffixed login; only the `[bot]` account
            // is the app, so this must not count as a Codex verdict.
            user: { login: 'chatgpt-codex-connector' },
          },
        ]);
      }
      if (requestUrl.includes('/commits/abc1234/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx),
    ).resolves.toEqual({ targetRevision: 'abc1234', rootComments: [], reviewPending: true });
  });

  it('keeps deferring on an unsubmitted draft review from a trusted author', async () => {
    // A PENDING review is a draft the author has not submitted: it carries no
    // inline comments yet, so selecting it would fall through to `clean` and
    // forge a passing verdict for a revision nobody has reviewed.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) {
        return jsonResponse([
          {
            id: 7,
            state: 'PENDING',
            commit_id: 'abc1234',
            submitted_at: null,
            body: '',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
        ]);
      }
      if (requestUrl.includes('/commits/abc1234/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx),
    ).resolves.toEqual({ targetRevision: 'abc1234', rootComments: [], reviewPending: true });
  });

  it('keeps deferring on a trusted review that has no submitted_at', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) {
        return jsonResponse([
          {
            id: 8,
            // A submitted-looking state is not enough on its own — the
            // timestamp is what GitHub only fills in on submit.
            state: 'COMMENTED',
            commit_id: 'abc1234',
            submitted_at: null,
            body: '',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
        ]);
      }
      if (requestUrl.includes('/commits/abc1234/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx),
    ).resolves.toEqual({ targetRevision: 'abc1234', rootComments: [], reviewPending: true });
  });

  it('is unavailable when the target revision cannot be resolved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ head: {} })),
    );

    await expect(
      createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx),
    ).resolves.toEqual({ unavailable: true });
  });

  it('reports a fetch failure as an error the adapter escalates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx),
    ).resolves.toEqual({ error: 'github_review_fetch_failed' });

    errorSpy.mockRestore();
  });

  it('honors the locked target revision over the PR head sha', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl === 'https://api.github.com/graphql') return threadsResponse([]);
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'newsha1' } });
      if (requestUrl.includes('/issues/42/comments')) return jsonResponse([]);
      if (requestUrl.includes('/pulls/42/reviews')) {
        return jsonResponse([
          {
            id: 7,
            state: 'COMMENTED',
            commit_id: 'deadbee1',
            submitted_at: '2026-08-14T00:00:00Z',
            body: 'Codex Review',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
        ]);
      }
      if (requestUrl.includes('/pulls/42/comments')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })({
      ...ctx,
      targetRevision: 'deadbee1',
    });

    expect(payload?.review?.id).toBe(7);
  });

  it('loads trusted root PR comments and drops untrusted authors', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/pulls/42/reviews')) return jsonResponse([]);
      if (requestUrl.includes('/commits/abc1234/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }
      if (requestUrl.includes('/issues/42/comments')) {
        return jsonResponse([
          {
            id: 1,
            body: 'Reviewed commit: `abc1234`\n\nNo issues found.',
            created_at: '2026-08-17T12:00:00Z',
            user: { login: 'chatgpt-codex-connector[bot]' },
          },
          {
            id: 2,
            body: 'Reviewed commit: `abc1234`\n\nNo issues found.',
            created_at: '2026-08-17T12:01:00Z',
            // Author matching is exact: the un-suffixed login is registrable by
            // a human, so a forged clean summary must not reach the adapter.
            user: { login: 'chatgpt-codex-connector' },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx);

    expect(payload?.targetRevision).toBe('abc1234');
    expect(payload?.rootComments?.map((comment) => comment.id)).toEqual([1]);
    expect(payload?.rootCommentsUnavailable).toBeUndefined();
  });

  it('reports a failed root-comment read as unavailable rather than as no comments', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.includes('/issues/42/comments')) return new Response('nope', { status: 502 });
      if (requestUrl.includes('/pulls/42/reviews')) return jsonResponse([]);
      if (requestUrl.includes('/commits/abc1234/check-runs')) {
        return jsonResponse({ check_runs: [] });
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const payload = await createGitHubCodexGitHubReviewLoader({ product, githubToken: 't' })(ctx);

    expect(payload?.rootCommentsUnavailable).toBe(true);
    expect(payload?.rootComments).toBeUndefined();
    warnSpy.mockRestore();
  });
});
