export type GitHubPullRequestRepository = {
  owner: string;
  repo: string;
};

export type CurrentPullRequestState = {
  repository: GitHubPullRequestRepository;
  pullRequestId: number;
  pullRequestNumber: number;
  headRef: string;
  headSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  htmlUrl: string;
};

const GITHUB_API_TIMEOUT_MS = 10_000;

export class GitHubPullRequestLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPullRequestLookupError';
  }
}

async function fetchGitHubJson<T>(url: string, token: string): Promise<T> {
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
      throw new GitHubPullRequestLookupError(`GitHub API request failed with status ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof GitHubPullRequestLookupError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GitHubPullRequestLookupError('GitHub API request timed out');
    }
    throw new GitHubPullRequestLookupError('GitHub API request failed');
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveCurrentPullRequestState(input: {
  repository: GitHubPullRequestRepository;
  pullRequestNumber: number;
  githubToken: string;
}): Promise<CurrentPullRequestState> {
  const pr = await fetchGitHubJson<{
    id: number;
    number: number;
    merged: boolean;
    merged_at: string | null;
    html_url: string;
    head?: { ref?: string; sha?: string | null };
  }>(
    `https://api.github.com/repos/${input.repository.owner}/${input.repository.repo}/pulls/${input.pullRequestNumber}`,
    input.githubToken,
  );

  const headRef = pr.head?.ref;
  if (!headRef) {
    throw new GitHubPullRequestLookupError('Pull request head ref is missing');
  }

  return {
    repository: input.repository,
    pullRequestId: pr.id,
    pullRequestNumber: pr.number,
    headRef,
    headSha: pr.head?.sha ?? null,
    merged: pr.merged === true || pr.merged_at !== null,
    mergedAt: pr.merged_at,
    htmlUrl: pr.html_url,
  };
}
