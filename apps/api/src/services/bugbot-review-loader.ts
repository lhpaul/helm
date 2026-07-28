import {
  DEFAULT_BUGBOT_CHECK_NAMES,
  DEFAULT_BUGBOT_TRUSTED_APP_IDENTITIES,
  type Product,
} from '@helm/shared';
import type { RunExternalReviewDeps } from '@helm/orchestrator';

type GitHubPullRequestResponse = {
  head?: { sha?: string };
};

type GitHubCheckRunResponse = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  app?: { slug?: string | null; name?: string | null } | null;
  started_at?: string | null;
  completed_at?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  } | null;
};

type GitHubCheckRunsResponse = {
  check_runs?: GitHubCheckRunResponse[];
};

type GitHubAnnotationResponse = {
  path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  annotation_level?: string | null;
  title?: string | null;
  message?: string | null;
  raw_details?: string | null;
};

type GitHubReviewCommentResponse = {
  id?: number | string;
  node_id?: string;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: { login?: string | null } | null;
};

type LoadedReviewThread = {
  id?: string | number;
  isResolved?: boolean;
  is_resolved?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: GitHubReviewCommentResponse[];
};

type GitHubGraphQLResponse<T> = {
  data?: T;
  errors?: { message?: string }[];
};

type GitHubReviewThreadsGraphQL = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: {
          id?: string;
          isResolved?: boolean;
          path?: string | null;
          line?: number | null;
          comments?: {
            nodes?: {
              databaseId?: number | null;
              id?: string;
              path?: string | null;
              line?: number | null;
              originalLine?: number | null;
              body?: string | null;
              author?: { login?: string | null } | null;
            }[];
          } | null;
        }[];
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
      } | null;
    } | null;
  } | null;
};

const GITHUB_API_TIMEOUT_MS = 10_000;
const GIT_SHA_RE = /^[0-9a-f]{7,64}$/i;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function configuredSet(values: string[] | undefined, fallback: string[]): Set<string> {
  const normalized = (values ?? []).map(normalize).filter((value) => value.length > 0);
  return new Set(normalized.length > 0 ? normalized : fallback.map(normalize));
}

function isTrustedBugbotCheckRun(checkRun: GitHubCheckRunResponse, product: Product): boolean {
  const bugbot = product.review?.external?.bugbot;
  const checkNames = configuredSet(bugbot?.check_names, DEFAULT_BUGBOT_CHECK_NAMES);
  const appIdentities = configuredSet(
    bugbot?.trusted_app_identities,
    DEFAULT_BUGBOT_TRUSTED_APP_IDENTITIES,
  );
  const name = checkRun.name ? normalize(checkRun.name) : '';
  if (!checkNames.has(name)) return false;
  const identities = [checkRun.app?.slug, checkRun.app?.name]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalize);
  return identities.some((identity) => appIdentities.has(identity));
}

function isTrustedBugbotComment(comment: GitHubReviewCommentResponse, product: Product): boolean {
  const appIdentities = configuredSet(
    product.review?.external?.bugbot?.trusted_app_identities,
    DEFAULT_BUGBOT_TRUSTED_APP_IDENTITIES,
  );
  const login = comment.user?.login;
  return typeof login === 'string' && appIdentities.has(normalize(login));
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
      throw new Error(`GitHub API request failed with status ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPaginatedGitHubJson<T>(url: string, token: string): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (true) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('per_page', '100');
    if (page > 1) pageUrl.searchParams.set('page', `${page}`);
    const pageItems = await fetchGitHubJson<T[]>(pageUrl.toString(), token);
    items.push(...pageItems);
    if (pageItems.length < 100) break;
    page += 1;
  }
  return items;
}

async function fetchGitHubGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'helm-api',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub GraphQL request failed with status ${res.status}`);
    }
    const payload = (await res.json()) as GitHubGraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL request failed: ${payload.errors[0]?.message ?? 'error'}`);
    }
    if (!payload.data) throw new Error('GitHub GraphQL response missing data');
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

function latestFirst(a: GitHubCheckRunResponse, b: GitHubCheckRunResponse): number {
  const aTime = Date.parse(a.completed_at ?? a.started_at ?? '');
  const bTime = Date.parse(b.completed_at ?? b.started_at ?? '');
  return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
}

const REVIEW_THREADS_QUERY = `
  query HelmBugbotReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) {
              nodes {
                databaseId
                id
                path
                line
                originalLine
                body
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchBugbotReviewThreads(input: {
  owner: string;
  repo: string;
  prNumber: number;
  product: Product;
  githubToken: string;
}): Promise<LoadedReviewThread[]> {
  const threads: LoadedReviewThread[] = [];
  let after: string | null | undefined;
  do {
    const data = await fetchGitHubGraphQL<GitHubReviewThreadsGraphQL>(
      REVIEW_THREADS_QUERY,
      {
        owner: input.owner,
        repo: input.repo,
        number: input.prNumber,
        after,
      },
      input.githubToken,
    );
    const page = data.repository?.pullRequest?.reviewThreads;
    for (const thread of page?.nodes ?? []) {
      if (thread.isResolved === true) continue;
      const comments = (thread.comments?.nodes ?? [])
        .map(
          (comment): GitHubReviewCommentResponse => ({
            id: comment.databaseId ?? comment.id,
            node_id: comment.id,
            path: comment.path ?? thread.path,
            line: comment.line ?? thread.line,
            original_line: comment.originalLine,
            body: comment.body,
            user: { login: comment.author?.login ?? null },
          }),
        )
        .filter((comment) => isTrustedBugbotComment(comment, input.product));
      if (comments.length === 0) continue;
      threads.push({
        id: thread.id,
        isResolved: thread.isResolved,
        path: thread.path,
        line: thread.line,
        comments,
      });
    }
    after = page?.pageInfo?.endCursor;
    if (page?.pageInfo?.hasNextPage !== true) break;
  } while (after);
  return threads;
}

export function createGitHubBugbotReviewLoader(input: {
  product: Product;
  githubToken: string;
}): NonNullable<RunExternalReviewDeps['loadBugbotReview']> {
  return async (ctx) => {
    const repoBase = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}`;
    const pr = await fetchGitHubJson<GitHubPullRequestResponse>(
      `${repoBase}/pulls/${ctx.prNumber}`,
      input.githubToken,
    );
    const targetSha = ctx.targetRevision ?? pr.head?.sha;
    if (!targetSha || !GIT_SHA_RE.test(targetSha)) return { unavailable: true };

    const checkRuns = await fetchGitHubJson<GitHubCheckRunsResponse>(
      `${repoBase}/commits/${targetSha}/check-runs?per_page=100`,
      input.githubToken,
    );
    const checkRun = (checkRuns.check_runs ?? [])
      .filter((candidate) => isTrustedBugbotCheckRun(candidate, input.product))
      .sort(latestFirst)[0];
    if (!checkRun) return { unavailable: true };

    const [annotations, reviewComments, reviewThreads] = await Promise.all([
      fetchPaginatedGitHubJson<GitHubAnnotationResponse>(
        `${repoBase}/check-runs/${checkRun.id}/annotations`,
        input.githubToken,
      ),
      fetchPaginatedGitHubJson<GitHubReviewCommentResponse>(
        `${repoBase}/pulls/${ctx.prNumber}/comments`,
        input.githubToken,
      ),
      fetchBugbotReviewThreads({
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        product: input.product,
        githubToken: input.githubToken,
      }),
    ]);

    return {
      checkRun: {
        name: checkRun.name,
        status: checkRun.status,
        conclusion: checkRun.conclusion,
        output: {
          title: checkRun.output?.title,
          summary: checkRun.output?.summary,
          text: checkRun.output?.text,
          annotations,
        },
      },
      reviewComments: reviewComments.filter((comment) =>
        isTrustedBugbotComment(comment, input.product),
      ),
      reviewThreads,
    };
  };
}
