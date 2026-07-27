import type { Product } from '@helm/shared';
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
  id?: number;
  node_id?: string;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: { login?: string | null } | null;
};

const GITHUB_API_TIMEOUT_MS = 10_000;
const DEFAULT_BUGBOT_CHECK_NAMES = ['Bugbot', 'Bugbot / Review', 'Cursor / Bugbot'];
const DEFAULT_BUGBOT_APP_IDENTITIES = ['bugbot', 'cursor', 'cursor[bot]', 'cursor bugbot'];

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
    DEFAULT_BUGBOT_APP_IDENTITIES,
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
    DEFAULT_BUGBOT_APP_IDENTITIES,
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

function latestFirst(a: GitHubCheckRunResponse, b: GitHubCheckRunResponse): number {
  const aTime = Date.parse(a.completed_at ?? a.started_at ?? '');
  const bTime = Date.parse(b.completed_at ?? b.started_at ?? '');
  return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
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
    const headSha = pr.head?.sha;
    if (!headSha) return { unavailable: true };

    const checkRuns = await fetchGitHubJson<GitHubCheckRunsResponse>(
      `${repoBase}/commits/${headSha}/check-runs?per_page=100`,
      input.githubToken,
    );
    const checkRun = (checkRuns.check_runs ?? [])
      .filter((candidate) => isTrustedBugbotCheckRun(candidate, input.product))
      .sort(latestFirst)[0];
    if (!checkRun) return { unavailable: true };

    const [annotations, reviewComments] = await Promise.all([
      fetchGitHubJson<GitHubAnnotationResponse[]>(
        `${repoBase}/check-runs/${checkRun.id}/annotations?per_page=100`,
        input.githubToken,
      ),
      fetchGitHubJson<GitHubReviewCommentResponse[]>(
        `${repoBase}/pulls/${ctx.prNumber}/comments?per_page=100`,
        input.githubToken,
      ),
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
    };
  };
}
