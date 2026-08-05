import {
  DEFAULT_CODERABBIT_STATUS_CONTEXTS,
  DEFAULT_CODERABBIT_TRUSTED_IDENTITIES,
  type Product,
} from '@helm/shared';
import type { RunExternalReviewDeps } from '@helm/orchestrator';

type GitHubPullRequestResponse = {
  head?: { sha?: string };
};

type GitHubCombinedStatusResponse = {
  statuses?: {
    context?: string;
    state?: string;
    description?: string | null;
    target_url?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }[];
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

function isTrustedCodeRabbitIdentity(login: string | undefined | null, product: Product): boolean {
  if (!login) return false;
  const identities = configuredSet(
    product.review?.external?.coderabbit?.trusted_identities,
    DEFAULT_CODERABBIT_TRUSTED_IDENTITIES,
  );
  return identities.has(normalize(login));
}

function isTrustedCodeRabbitStatusContext(context: string | undefined, product: Product): boolean {
  if (!context) return false;
  const contexts = configuredSet(
    product.review?.external?.coderabbit?.status_contexts,
    DEFAULT_CODERABBIT_STATUS_CONTEXTS,
  );
  return contexts.has(normalize(context));
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

const REVIEW_THREADS_QUERY = `
  query HelmCodeRabbitReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
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

async function fetchCodeRabbitReviewThreads(input: {
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
        .filter((comment) => isTrustedCodeRabbitIdentity(comment.user?.login, input.product));
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

export function createGitHubCodeRabbitReviewLoader(input: {
  product: Product;
  githubToken: string;
}): NonNullable<RunExternalReviewDeps['loadCodeRabbitReview']> {
  return async (ctx) => {
    const repoBase = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}`;
    const pr = await fetchGitHubJson<GitHubPullRequestResponse>(
      `${repoBase}/pulls/${ctx.prNumber}`,
      input.githubToken,
    );
    const targetSha = ctx.targetRevision ?? pr.head?.sha;
    if (!targetSha || !GIT_SHA_RE.test(targetSha)) return { unavailable: true };

    const combined = await fetchGitHubJson<GitHubCombinedStatusResponse>(
      `${repoBase}/commits/${targetSha}/status`,
      input.githubToken,
    );
    const status = (combined.statuses ?? []).find((candidate) =>
      isTrustedCodeRabbitStatusContext(candidate.context, input.product),
    );
    if (!status) return { unavailable: true };

    const [reviewComments, reviewThreads] = await Promise.all([
      fetchPaginatedGitHubJson<GitHubReviewCommentResponse>(
        `${repoBase}/pulls/${ctx.prNumber}/comments`,
        input.githubToken,
      ),
      fetchCodeRabbitReviewThreads({
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        product: input.product,
        githubToken: input.githubToken,
      }),
    ]);

    return {
      status: {
        context: status.context,
        state: status.state,
        description: status.description,
        target_url: status.target_url,
        created_at: status.created_at,
        updated_at: status.updated_at,
      },
      reviewComments: reviewComments.filter((comment) =>
        isTrustedCodeRabbitIdentity(comment.user?.login, input.product),
      ),
      reviewThreads,
    };
  };
}
