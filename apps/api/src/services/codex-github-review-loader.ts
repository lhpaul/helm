import {
  DEFAULT_CODEX_GITHUB_CHECK_NAMES,
  DEFAULT_CODEX_GITHUB_TRUSTED_IDENTITIES,
  type Product,
} from '@helm/shared';
import type { RunExternalReviewDeps } from '@helm/orchestrator';

type GitHubPullRequestResponse = {
  head?: { sha?: string };
};

type GitHubReviewResponse = {
  id?: number | string;
  node_id?: string;
  state?: string;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
  user?: { login?: string | null } | null;
};

type GitHubCheckRunResponse = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string | null;
  app?: { slug?: string | null; name?: string | null } | null;
};

type GitHubCheckRunsResponse = {
  check_runs?: GitHubCheckRunResponse[];
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

function isTrustedCodexIdentity(login: string | undefined | null, product: Product): boolean {
  if (!login) return false;
  const identities = configuredSet(
    product.review?.external?.codex_github?.trusted_identities,
    DEFAULT_CODEX_GITHUB_TRUSTED_IDENTITIES,
  );
  return identities.has(normalize(login));
}

/**
 * Matches a GitHub **App** identity (slug or display name) against the trusted
 * logins, ignoring the `[bot]` suffix on either side.
 *
 * An app's bot account logs in as `<slug>[bot]` while the app record itself
 * carries the bare slug, so a config listing only the login form would silently
 * fail to recognize the app's own check run. The relaxation is safe in this
 * direction only: the app slug comes from GitHub's app record, not from a
 * user-settable account name — so review **author** matching below stays exact,
 * where a human could otherwise register the un-suffixed login.
 */
function isTrustedCodexAppIdentity(identity: string | undefined | null, product: Product): boolean {
  if (!identity) return false;
  const stripBotSuffix = (value: string): string => normalize(value).replace(/\[bot\]$/, '');
  const identities = configuredSet(
    product.review?.external?.codex_github?.trusted_identities,
    DEFAULT_CODEX_GITHUB_TRUSTED_IDENTITIES,
  );
  const candidate = stripBotSuffix(identity);
  return [...identities].some((trusted) => stripBotSuffix(trusted) === candidate);
}

/**
 * A check run counts as Codex's only when the name is allowlisted **and** the
 * publishing app identity is trusted — a matching name from any other app is
 * ignored (the ADR-036 Option B trust boundary).
 */
function isTrustedCodexCheckRun(checkRun: GitHubCheckRunResponse, product: Product): boolean {
  const name = checkRun.name;
  if (!name) return false;
  const checkNames = configuredSet(
    product.review?.external?.codex_github?.check_names,
    DEFAULT_CODEX_GITHUB_CHECK_NAMES,
  );
  if (!checkNames.has(normalize(name))) return false;
  return [checkRun.app?.slug, checkRun.app?.name].some((identity) =>
    isTrustedCodexAppIdentity(identity, product),
  );
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
  query HelmCodexReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
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

async function fetchCodexReviewThreads(input: {
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
        .filter((comment) => isTrustedCodexIdentity(comment.user?.login, input.product));
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

/**
 * Loads the Codex GitHub review payload for a PR (ADR-036).
 *
 * Codex signals completion by **submitting a PR review**, not by publishing a
 * commit status, so the trust anchor is the review author login and the
 * readiness test is "a trusted review exists for this exact revision".
 */
export function createGitHubCodexGitHubReviewLoader(input: {
  product: Product;
  githubToken: string;
}): NonNullable<RunExternalReviewDeps['loadCodexGitHubReview']> {
  return async (ctx) => {
    const repoBase = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}`;
    try {
      const pr = await fetchGitHubJson<GitHubPullRequestResponse>(
        `${repoBase}/pulls/${ctx.prNumber}`,
        input.githubToken,
      );
      const targetSha = ctx.targetRevision ?? pr.head?.sha;
      if (!targetSha || !GIT_SHA_RE.test(targetSha)) return { unavailable: true };

      const reviews = await fetchPaginatedGitHubJson<GitHubReviewResponse>(
        `${repoBase}/pulls/${ctx.prNumber}/reviews`,
        input.githubToken,
      );
      // GitHub returns reviews oldest-first; the last trusted match is the
      // current verdict for this revision.
      const review = reviews
        .filter(
          (candidate) =>
            isTrustedCodexIdentity(candidate.user?.login, input.product) &&
            typeof candidate.commit_id === 'string' &&
            normalize(candidate.commit_id) === normalize(targetSha),
        )
        .at(-1);

      if (!review) {
        // Surface an in-flight Codex check run, when it publishes one, so the
        // pending reason names the analysis instead of the missing review.
        const checkRuns = await fetchGitHubJson<GitHubCheckRunsResponse>(
          `${repoBase}/commits/${targetSha}/check-runs?per_page=100`,
          input.githubToken,
        ).catch(() => ({ check_runs: [] }) as GitHubCheckRunsResponse);
        const checkRun = (checkRuns.check_runs ?? []).find((candidate) =>
          isTrustedCodexCheckRun(candidate, input.product),
        );
        return {
          reviewPending: true,
          ...(checkRun
            ? {
                checkRun: {
                  name: checkRun.name,
                  status: checkRun.status,
                  conclusion: checkRun.conclusion,
                  head_sha: checkRun.head_sha,
                },
              }
            : {}),
        };
      }

      const [reviewComments, reviewThreads] = await Promise.all([
        fetchPaginatedGitHubJson<GitHubReviewCommentResponse>(
          `${repoBase}/pulls/${ctx.prNumber}/comments`,
          input.githubToken,
        ),
        fetchCodexReviewThreads({
          owner: ctx.owner,
          repo: ctx.repo,
          prNumber: ctx.prNumber,
          product: input.product,
          githubToken: input.githubToken,
        }),
      ]);
      const trustedResolvedThreadCommentIds = new Set(
        reviewThreads
          .filter((thread) => thread.isResolved === true || thread.is_resolved === true)
          .flatMap((thread) => thread.comments ?? [])
          .flatMap((comment) => [comment.id, comment.node_id])
          .filter((id): id is string | number => id !== undefined),
      );

      return {
        review: {
          id: review.id,
          node_id: review.node_id,
          state: review.state,
          body: review.body,
          commit_id: review.commit_id,
          submitted_at: review.submitted_at,
          user: { login: review.user?.login ?? null },
        },
        reviewComments: reviewComments.filter(
          (comment) =>
            isTrustedCodexIdentity(comment.user?.login, input.product) &&
            !trustedResolvedThreadCommentIds.has(comment.id ?? '') &&
            !trustedResolvedThreadCommentIds.has(comment.node_id ?? ''),
        ),
        reviewThreads: reviewThreads.filter(
          (thread) => thread.isResolved !== true && thread.is_resolved !== true,
        ),
      };
    } catch (err) {
      console.error('[codex-github-review-loader] Failed to load GitHub review payload:', err);
      return { error: 'github_review_fetch_failed' };
    }
  };
}
