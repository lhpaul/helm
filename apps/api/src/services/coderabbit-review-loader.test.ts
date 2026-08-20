import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import { createGitHubCodeRabbitReviewLoader } from './coderabbit-review-loader.js';

const product = {
  product: { slug: 'test', name: 'Test' },
  review: {
    external: {
      provider: 'coderabbit',
      coderabbit: {
        status_contexts: ['CodeRabbit Custom'],
        trusted_identities: ['coderabbitai[bot]'],
        blocking_severities: ['critical', 'high', 'medium'],
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

function emptyThreadsResponse(): Response {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
}

describe('createGitHubCodeRabbitReviewLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires trusted context and creator while loading paginated statuses', async () => {
    const firstPageStatuses = Array.from({ length: 100 }, (_, index) => ({
      context: `other-${index}`,
      state: 'success',
      creator: { login: 'some-bot' },
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/status?per_page=100')) {
        return jsonResponse({ statuses: firstPageStatuses });
      }
      if (requestUrl.endsWith('/commits/abc1234/status?per_page=100&page=2')) {
        return jsonResponse({
          statuses: [
            {
              context: 'CodeRabbit Custom',
              state: 'success',
              creator: { login: 'untrusted-user' },
            },
            {
              context: 'CodeRabbit Custom',
              state: 'success',
              description: 'Review completed',
              target_url: 'https://coderabbit.ai/review',
              creator: { login: 'coderabbitai[bot]' },
            },
          ],
        });
      }
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) return jsonResponse([]);
      if (requestUrl === 'https://api.github.com/graphql') return emptyThreadsResponse();
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubCodeRabbitReviewLoader({ product, githubToken: 'token' });
    const result = await loader(ctx);

    expect(result?.status).toMatchObject({
      context: 'CodeRabbit Custom',
      state: 'success',
      description: 'Review completed',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/commits/abc1234/status?per_page=100&page=2'),
      expect.any(Object),
    );
  });

  it('rejects untrusted creator and returns synthetic pending until a trusted status appears', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/status?per_page=100')) {
        return jsonResponse({
          statuses: [
            {
              context: 'CodeRabbit Custom',
              state: 'success',
              creator: { login: 'untrusted-user' },
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubCodeRabbitReviewLoader({ product, githubToken: 'token' });

    // Untrusted creator is rejected; with no trusted/null-creator match we defer
    // (synthetic pending) rather than skip/unavailable.
    await expect(loader(ctx)).resolves.toEqual({
      status: {
        context: 'CodeRabbit Custom',
        state: 'pending',
        description: 'awaiting CodeRabbit status',
      },
    });
  });

  it('accepts allowlisted status context when creator is null', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/status?per_page=100')) {
        return jsonResponse({
          statuses: [
            {
              context: 'CodeRabbit Custom',
              state: 'success',
              description: 'Review completed',
              target_url: 'https://coderabbit.ai/review',
              creator: null,
            },
          ],
        });
      }
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) {
        return jsonResponse([]);
      }
      if (requestUrl.includes('api.github.com/graphql')) {
        return emptyThreadsResponse();
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubCodeRabbitReviewLoader({ product, githubToken: 'token' });
    const result = await loader(ctx);

    expect(result).toMatchObject({
      status: {
        context: 'CodeRabbit Custom',
        state: 'success',
        description: 'Review completed',
      },
      reviewComments: [],
    });
    expect(result).not.toHaveProperty('unavailable');
  });

  it('returns synthetic pending when no CodeRabbit status exists yet', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/status?per_page=100')) {
        return jsonResponse({
          statuses: [{ context: 'ci', state: 'success', creator: { login: 'github' } }],
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubCodeRabbitReviewLoader({ product, githubToken: 'token' });

    await expect(loader(ctx)).resolves.toEqual({
      status: {
        context: 'CodeRabbit Custom',
        state: 'pending',
        description: 'awaiting CodeRabbit status',
      },
    });
  });

  it('filters REST comments that belong to resolved CodeRabbit threads', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/status?per_page=100')) {
        return jsonResponse({
          statuses: [
            {
              context: 'CodeRabbit Custom',
              state: 'success',
              creator: { login: 'coderabbitai[bot]' },
            },
          ],
        });
      }
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) {
        return jsonResponse([
          {
            id: 201,
            node_id: 'comment-201',
            body: '**HIGH** resolved',
            user: { login: 'coderabbitai[bot]' },
          },
          {
            id: 202,
            node_id: 'comment-202',
            body: '**HIGH** open',
            user: { login: 'coderabbitai[bot]' },
          },
          { id: 203, node_id: 'comment-203', body: '**HIGH** spoofed', user: { login: 'spoofed' } },
        ]);
      }
      if (requestUrl === 'https://api.github.com/graphql') {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'resolved-thread',
                      isResolved: true,
                      path: 'src/old.ts',
                      line: 3,
                      comments: {
                        nodes: [
                          {
                            databaseId: 201,
                            id: 'comment-201',
                            body: '**HIGH** resolved',
                            author: { login: 'coderabbitai[bot]' },
                          },
                        ],
                      },
                    },
                    {
                      id: 'open-thread',
                      isResolved: false,
                      path: 'src/new.ts',
                      line: 8,
                      comments: {
                        nodes: [
                          {
                            databaseId: 202,
                            id: 'comment-202',
                            body: '**HIGH** open',
                            author: { login: 'coderabbitai[bot]' },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubCodeRabbitReviewLoader({ product, githubToken: 'token' });
    const result = await loader(ctx);

    expect(result?.reviewComments).toEqual([
      expect.objectContaining({ id: 202, body: '**HIGH** open' }),
    ]);
    expect(result?.reviewThreads).toEqual([
      expect.objectContaining({
        id: 'open-thread',
        comments: [expect.objectContaining({ id: 202, body: '**HIGH** open' })],
      }),
    ]);
  });

  it('maps GitHub transport failures to a sanitized review-domain error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limit details', { status: 403 })),
    );

    const loader = createGitHubCodeRabbitReviewLoader({ product, githubToken: 'token' });

    await expect(loader(ctx)).resolves.toEqual({ error: 'github_review_fetch_failed' });
  });
});
