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

export type GitHubPullRequestLookupErrorCode =
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'bad_response'
  | 'upstream_failure';

export class GitHubPullRequestLookupError extends Error {
  public readonly code: GitHubPullRequestLookupErrorCode;
  public readonly githubStatus?: number;

  constructor(
    message: string,
    options: { code: GitHubPullRequestLookupErrorCode; githubStatus?: number },
  ) {
    super(message);
    this.name = 'GitHubPullRequestLookupError';
    this.code = options.code;
    this.githubStatus = options.githubStatus;
  }
}

function lookupErrorFromGitHubResponse(res: Response): GitHubPullRequestLookupError {
  if (res.status === 404) {
    return new GitHubPullRequestLookupError('Pull request not found', {
      code: 'not_found',
      githubStatus: res.status,
    });
  }
  if (res.status === 401) {
    return new GitHubPullRequestLookupError('GitHub token is unauthorized', {
      code: 'unauthorized',
      githubStatus: res.status,
    });
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return new GitHubPullRequestLookupError('GitHub API rate limit exceeded', {
      code: 'rate_limited',
      githubStatus: res.status,
    });
  }
  if (res.status === 403) {
    return new GitHubPullRequestLookupError('GitHub API access forbidden', {
      code: 'forbidden',
      githubStatus: res.status,
    });
  }
  return new GitHubPullRequestLookupError(`GitHub API request failed with status ${res.status}`, {
    code: 'upstream_failure',
    githubStatus: res.status,
  });
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
      throw lookupErrorFromGitHubResponse(res);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof GitHubPullRequestLookupError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GitHubPullRequestLookupError('GitHub API request timed out', { code: 'timeout' });
    }
    throw new GitHubPullRequestLookupError('GitHub API request failed', {
      code: 'upstream_failure',
    });
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
    throw new GitHubPullRequestLookupError('Pull request head ref is missing', {
      code: 'bad_response',
    });
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
