import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubPrError,
  authorHasWriteAccess,
  getPrimaryCodeRepo,
  listPrIssueComments,
  parseGitHubRepoUrl,
  resolveOpenPrMetadata,
} from './github-pr.js';

const product = {
  product: { slug: 'test-app', name: 'Test' },
  code_repos: [
    { url: 'https://github.com/test-org/test-repo.git', default_branch: 'main', role: 'app' },
  ],
} as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github-pr', () => {
  it('parses GitHub repo URLs', () => {
    expect(parseGitHubRepoUrl('https://github.com/test-org/test-repo.git')).toEqual({
      owner: 'test-org',
      repo: 'test-repo',
    });
  });

  it('rejects non-GitHub repo URLs', () => {
    expect(() => parseGitHubRepoUrl('https://example.com/o/r')).toThrow(GitHubPrError);
  });

  it('wraps malformed URLs as GitHubPrError', () => {
    expect(() => parseGitHubRepoUrl('not a url')).toThrow(GitHubPrError);
    expect(() => parseGitHubRepoUrl('not a url')).toThrow(/Invalid code repo URL/);
  });

  it('resolves the primary app code repo', () => {
    expect(getPrimaryCodeRepo(product)).toEqual({ owner: 'test-org', repo: 'test-repo' });
  });

  it('fetches open PR head metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        number: 42,
        state: 'open',
        html_url: 'https://github.com/test-org/test-repo/pull/42',
        head: { ref: 'helm/impl/issue_42', sha: 'abc123' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveOpenPrMetadata({ product, prNumber: 42, githubToken: 'token' }),
    ).resolves.toEqual({
      owner: 'test-org',
      repo: 'test-repo',
      number: 42,
      headRef: 'helm/impl/issue_42',
      headSha: 'abc123',
      htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/test-org/test-repo/pulls/42',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fails closed when the PR is not open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          number: 42,
          state: 'closed',
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          head: { ref: 'helm/impl/issue_42', sha: 'abc123' },
        }),
      }),
    );

    await expect(
      resolveOpenPrMetadata({ product, prNumber: 42, githubToken: 'token' }),
    ).rejects.toThrow('Pull request is not open');
  });

  it('checks write-equivalent collaborator permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ permission: 'write' }),
      }),
    );

    await expect(
      authorHasWriteAccess({ product, login: 'maintainer', githubToken: 'token' }),
    ).resolves.toBe(true);
  });

  it('lists PR issue comments with bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: vi.fn().mockResolvedValue([
        { id: 1, body: '# Review Adjudication: issue_42' },
        { id: 2, body: null },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listPrIssueComments({ product, prNumber: 42, githubToken: 'token' }),
    ).resolves.toEqual([{ id: 1, body: '# Review Adjudication: issue_42' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/test-org/test-repo/issues/42/comments?per_page=100',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('paginates PR issue comments via Link rel=next', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'link'
              ? '<https://api.github.com/repos/test-org/test-repo/issues/42/comments?page=2>; rel="next"'
              : null,
        },
        json: vi.fn().mockResolvedValue([{ id: 1, body: 'page-1' }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: vi.fn().mockResolvedValue([{ id: 2, body: 'page-2' }]),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listPrIssueComments({ product, prNumber: 42, githubToken: 'token' }),
    ).resolves.toEqual([
      { id: 1, body: 'page-1' },
      { id: 2, body: 'page-2' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
