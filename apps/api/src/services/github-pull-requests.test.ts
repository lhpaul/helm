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
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('classifies unauthorized tokens distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
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

    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('classifies timeouts distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    try {
      await expect(
        resolveCurrentPullRequestState({
          repository: { owner: 'example-org', repo: 'example-app' },
          pullRequestNumber: 7,
          githubToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'timeout',
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

    try {
      const error = await resolveCurrentPullRequestState({
        repository: { owner: 'example-org', repo: 'example-app' },
        pullRequestNumber: 7,
        githubToken: 'token',
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(GitHubPullRequestLookupError);
      expect(error).toMatchObject({
        code: 'bad_response',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a successful GitHub payload to current PR state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 5001,
          number: 7,
          merged: true,
          merged_at: '2026-07-21T12:00:00Z',
          html_url: 'https://github.com/example-org/example-app/pull/7',
          head: { ref: 'helm/impl/HLM-1', sha: 'sha-1' },
        }),
      ),
    );

    try {
      await expect(
        resolveCurrentPullRequestState({
          repository: { owner: 'example-org', repo: 'example-app' },
          pullRequestNumber: 7,
          githubToken: 'token',
        }),
      ).resolves.toMatchObject({
        pullRequestId: 5001,
        headRef: 'helm/impl/HLM-1',
        merged: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
