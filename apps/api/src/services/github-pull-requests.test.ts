import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubPullRequestLookupError,
  resolveCurrentPullRequestState,
} from './github-pull-requests.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveCurrentPullRequestState', () => {
  it('classifies missing pull requests as not_found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

    await expect(
      resolveCurrentPullRequestState({
        repository: { owner: 'example-org', repo: 'example-app' },
        pullRequestNumber: 7,
        githubToken: 'token',
      }),
    ).rejects.toMatchObject({
      name: 'GitHubPullRequestLookupError',
      code: 'not_found',
      githubStatus: 404,
    });
  });

  it('classifies unauthorized tokens distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    await expect(
      resolveCurrentPullRequestState({
        repository: { owner: 'example-org', repo: 'example-app' },
        pullRequestNumber: 7,
        githubToken: 'token',
      }),
    ).rejects.toMatchObject({
      code: 'unauthorized',
      githubStatus: 401,
    });
  });

  it('classifies GitHub rate limit responses distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
      ),
    );

    await expect(
      resolveCurrentPullRequestState({
        repository: { owner: 'example-org', repo: 'example-app' },
        pullRequestNumber: 7,
        githubToken: 'token',
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      githubStatus: 403,
    });
  });

  it('classifies timeouts distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    await expect(
      resolveCurrentPullRequestState({
        repository: { owner: 'example-org', repo: 'example-app' },
        pullRequestNumber: 7,
        githubToken: 'token',
      }),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('classifies missing required PR fields as bad_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 5001,
          number: 7,
          merged: true,
          merged_at: '2026-07-21T12:00:00Z',
          html_url: 'https://github.com/example-org/example-app/pull/7',
          head: { sha: 'sha-1' },
        }),
      ),
    );

    const error = await resolveCurrentPullRequestState({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
      githubToken: 'token',
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GitHubPullRequestLookupError);
    expect(error).toMatchObject({
      code: 'bad_response',
    });
  });
});
