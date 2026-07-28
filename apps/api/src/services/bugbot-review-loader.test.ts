import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Product } from '@helm/shared';
import { createGitHubBugbotReviewLoader } from './bugbot-review-loader.js';

const product = {
  product: { slug: 'test', name: 'Test' },
  review: {
    external: {
      provider: 'bugbot',
      bugbot: {
        check_names: ['Bugbot / Review'],
        trusted_app_identities: ['bugbot'],
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

describe('createGitHubBugbotReviewLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the latest trusted Bugbot check run and filters comments by trusted app', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) {
        return jsonResponse({ head: { sha: 'abc1234' } });
      }
      if (requestUrl.endsWith('/commits/abc1234/check-runs?per_page=100')) {
        return jsonResponse({
          check_runs: [
            {
              id: 1,
              name: 'Bugbot / Review',
              status: 'completed',
              conclusion: 'success',
              app: { slug: 'spoofed' },
              completed_at: '2026-07-22T10:00:00Z',
            },
            {
              id: 2,
              name: 'Bugbot / Review',
              status: 'completed',
              conclusion: 'neutral',
              app: { slug: 'bugbot' },
              completed_at: '2026-07-22T11:00:00Z',
            },
          ],
        });
      }
      if (requestUrl.endsWith('/check-runs/2/annotations?per_page=100')) {
        return jsonResponse([{ path: 'x.ts', start_line: 1, annotation_level: 'warning' }]);
      }
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) {
        return jsonResponse([
          { id: 1, body: '**HIGH** trusted', user: { login: 'bugbot' } },
          { id: 2, body: '**HIGH** spoofed', user: { login: 'random-user' } },
        ]);
      }
      if (requestUrl === 'https://api.github.com/graphql') {
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
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubBugbotReviewLoader({ product, githubToken: 'token' });
    const result = await loader(ctx);

    expect(result?.checkRun?.conclusion).toBe('neutral');
    expect(result?.checkRun?.output?.annotations).toHaveLength(1);
    expect(result?.reviewComments).toEqual([
      expect.objectContaining({ id: 1, body: '**HIGH** trusted' }),
    ]);
  });

  it('uses a locked target revision instead of the live PR head', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) {
        return jsonResponse({ head: { sha: 'live-sha-1' } });
      }
      if (requestUrl.endsWith('/commits/deadbee/check-runs?per_page=100')) {
        return jsonResponse({
          check_runs: [
            {
              id: 2,
              name: 'Bugbot / Review',
              status: 'completed',
              conclusion: 'success',
              app: { slug: 'bugbot' },
            },
          ],
        });
      }
      if (requestUrl.endsWith('/check-runs/2/annotations?per_page=100')) return jsonResponse([]);
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) return jsonResponse([]);
      if (requestUrl === 'https://api.github.com/graphql') {
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
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubBugbotReviewLoader({ product, githubToken: 'token' });
    await expect(loader({ ...ctx, targetRevision: 'deadbee' })).resolves.toMatchObject({
      checkRun: { conclusion: 'success' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/commits/deadbee/check-runs'),
      expect.any(Object),
    );
  });

  it('returns unavailable when no PR head SHA or locked target revision exists', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: {} });
      throw new Error(`unexpected URL ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createGitHubBugbotReviewLoader({ product, githubToken: 'token' });

    await expect(loader(ctx)).resolves.toEqual({ unavailable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads unresolved trusted Bugbot review threads for adapter normalization', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/check-runs?per_page=100')) {
        return jsonResponse({
          check_runs: [
            {
              id: 2,
              name: 'Bugbot / Review',
              status: 'completed',
              conclusion: 'success',
              app: { slug: 'bugbot' },
            },
          ],
        });
      }
      if (requestUrl.endsWith('/check-runs/2/annotations?per_page=100')) return jsonResponse([]);
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) return jsonResponse([]);
      if (requestUrl === 'https://api.github.com/graphql') {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'thread-1',
                      isResolved: false,
                      path: 'src/app.ts',
                      line: 12,
                      comments: {
                        nodes: [
                          {
                            databaseId: 10,
                            id: 'comment-10',
                            body: '**HIGH** thread finding',
                            author: { login: 'bugbot' },
                          },
                          {
                            databaseId: 11,
                            id: 'comment-11',
                            body: '**HIGH** spoofed',
                            author: { login: 'random-user' },
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

    const loader = createGitHubBugbotReviewLoader({ product, githubToken: 'token' });
    const result = await loader(ctx);

    expect(result?.reviewThreads).toEqual([
      {
        id: 'thread-1',
        isResolved: false,
        path: 'src/app.ts',
        line: 12,
        comments: [
          expect.objectContaining({
            id: 10,
            node_id: 'comment-10',
            body: '**HIGH** thread finding',
            user: { login: 'bugbot' },
          }),
        ],
      },
    ]);
  });

  it('skips resolved threads and loads paginated comments and thread pages', async () => {
    const firstPageComments = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `**LOW** trusted ${index + 1}`,
      user: { login: 'bugbot' },
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === 'string' ? url : url.toString();
      if (requestUrl.endsWith('/pulls/42')) return jsonResponse({ head: { sha: 'abc1234' } });
      if (requestUrl.endsWith('/commits/abc1234/check-runs?per_page=100')) {
        return jsonResponse({
          check_runs: [
            {
              id: 2,
              name: 'Bugbot / Review',
              status: 'completed',
              conclusion: 'success',
              app: { slug: 'bugbot' },
            },
          ],
        });
      }
      if (requestUrl.endsWith('/check-runs/2/annotations?per_page=100')) return jsonResponse([]);
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100')) {
        return jsonResponse(firstPageComments);
      }
      if (requestUrl.endsWith('/pulls/42/comments?per_page=100&page=2')) {
        return jsonResponse([{ id: 101, body: '**LOW** trusted 101', user: { login: 'bugbot' } }]);
      }
      if (requestUrl === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          variables?: { after?: string | null };
        };
        if (!body.variables?.after) {
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
                              body: '**HIGH** resolved finding',
                              author: { login: 'bugbot' },
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                  },
                },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
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
                            body: '**HIGH** open finding',
                            author: { login: 'bugbot' },
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

    const loader = createGitHubBugbotReviewLoader({ product, githubToken: 'token' });
    const result = await loader(ctx);

    expect(result?.reviewComments).toHaveLength(101);
    expect(result?.reviewThreads).toEqual([
      expect.objectContaining({
        id: 'open-thread',
        path: 'src/new.ts',
        comments: [expect.objectContaining({ id: 202, body: '**HIGH** open finding' })],
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/pulls/42/comments?per_page=100&page=2'),
      expect.any(Object),
    );
  });
});
