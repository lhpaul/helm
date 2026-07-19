import type { Product } from '@helm/shared';

export type GitHubRepoRef = {
  owner: string;
  repo: string;
};

export type GitHubPrMetadata = GitHubRepoRef & {
  number: number;
  headRef: string;
  headSha: string;
  htmlUrl: string;
};

export type GitHubIssueComment = {
  id: number;
  body: string;
};

const GITHUB_API_TIMEOUT_MS = 10_000;

export class GitHubPrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPrError';
  }
}

export function parseGitHubRepoUrl(url: string): GitHubRepoRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitHubPrError('Invalid code repo URL');
  }
  if (parsed.hostname !== 'github.com') {
    throw new GitHubPrError('Code repo URL must be a github.com URL');
  }
  const [owner, repoWithSuffix] = parsed.pathname.replace(/^\/+/, '').split('/');
  const repo = repoWithSuffix?.replace(/\.git$/, '');
  if (!owner || !repo) {
    throw new GitHubPrError('Code repo URL must include owner and repo');
  }
  return { owner, repo };
}

export function getPrimaryCodeRepo(product: Product): GitHubRepoRef {
  const repo = product.code_repos.find((entry) => entry.role === 'app') ?? product.code_repos[0];
  if (!repo) throw new GitHubPrError('Product has no configured code repo');
  return parseGitHubRepoUrl(repo.url);
}

async function fetchGitHubResponse(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'helm-api',
        'x-github-api-version': '2022-11-28',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new GitHubPrError(`GitHub API request failed with status ${res.status}`);
    }
    return res;
  } catch (err) {
    if (err instanceof GitHubPrError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GitHubPrError('GitHub API request timed out');
    }
    throw new GitHubPrError('GitHub API request failed');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGitHubJson<T>(url: string, token: string): Promise<T> {
  const res = await fetchGitHubResponse(url, token);
  return (await res.json()) as T;
}

function nextLinkFromHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="next"$/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export async function resolveOpenPrMetadata(input: {
  product: Product;
  prNumber: number;
  githubToken: string;
}): Promise<GitHubPrMetadata> {
  const repo = getPrimaryCodeRepo(input.product);
  const pr = await fetchGitHubJson<{
    number: number;
    state: string;
    html_url: string;
    head?: { ref?: string; sha?: string };
  }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${input.prNumber}`,
    input.githubToken,
  );

  if (pr.state !== 'open') throw new GitHubPrError('Pull request is not open');
  const headRef = pr.head?.ref;
  const headSha = pr.head?.sha;
  if (!headRef || !headSha) throw new GitHubPrError('Pull request head metadata is incomplete');

  return {
    ...repo,
    number: pr.number,
    headRef,
    headSha,
    htmlUrl: pr.html_url,
  };
}

export async function listPrIssueComments(input: {
  product: Product;
  prNumber: number;
  githubToken: string;
}): Promise<GitHubIssueComment[]> {
  const repo = getPrimaryCodeRepo(input.product);
  const all: GitHubIssueComment[] = [];
  let url: string | null =
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${input.prNumber}/comments?per_page=100`;

  while (url) {
    const res = await fetchGitHubResponse(url, input.githubToken);
    const comments = (await res.json()) as Array<{ id: number; body?: string | null }>;
    for (const comment of comments) {
      if (typeof comment.body === 'string') {
        all.push({ id: comment.id, body: comment.body });
      }
    }
    url = nextLinkFromHeader(res.headers.get('link'));
  }

  return all;
}

export async function authorHasWriteAccess(input: {
  product: Product;
  login: string;
  githubToken: string;
}): Promise<boolean> {
  const repo = getPrimaryCodeRepo(input.product);
  const permission = await fetchGitHubJson<{ permission?: string }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/collaborators/${input.login}/permission`,
    input.githubToken,
  );
  return ['admin', 'maintain', 'write'].includes(permission.permission ?? '');
}
