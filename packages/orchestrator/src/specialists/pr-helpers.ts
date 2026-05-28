/**
 * PR-finding and PR-commenting helpers for reviewer specialists.
 *
 * `findCodePRUrl` — queries GitHub via gh CLI for the open `helm/impl/{externalId}`
 *   PR; returns null if no open PR exists (implementer hasn't opened one, or it
 *   was closed). GitHub is the source of truth — no ItemState lookup needed.
 *
 * `postPRComment` — posts a review comment on a GitHub PR as the orchestrator
 *   (GITHUB_TOKEN never enters agent subprocesses).
 */
import type { CodeRepo } from '@helm/shared';
import { implBranchName } from '@helm/shared';
import { parseGitHubRepoUrl } from './fetch-product-context.js';
import { defaultRunGh, type RunGh } from './git-helpers.js';

// ── findCodePRUrl ─────────────────────────────────────────────────────────────

export type FindCodePROpts = {
  codeRepo: CodeRepo;
  externalId: string;
  githubToken: string;
};

/**
 * Finds the URL of the open impl PR for the given item by querying GitHub via gh CLI.
 * Returns null if no open PR exists (implementer hasn't opened one, or it was closed).
 * Throws on unexpected gh errors.
 */
export async function findCodePRUrl(
  opts: FindCodePROpts,
  runGh: RunGh = defaultRunGh,
): Promise<string | null> {
  const { codeRepo, externalId, githubToken } = opts;

  const parsed = parseGitHubRepoUrl(codeRepo.url);
  if (!parsed) {
    throw new Error(`[pr-helpers] Cannot parse code repo URL: ${codeRepo.url}`);
  }
  const { owner, repo } = parsed;
  const branchName = implBranchName(externalId);

  const result = await runGh(
    [
      'pr',
      'list',
      '--repo',
      `${owner}/${repo}`,
      '--head',
      branchName,
      '--state',
      'open',
      '--json',
      'url',
    ],
    { env: { GITHUB_TOKEN: githubToken } },
  );

  const prs = JSON.parse(result.stdout.trim()) as { url: string }[];
  if (prs.length > 0) return prs[0]!.url;
  return null;
}

// ── postPRComment ─────────────────────────────────────────────────────────────

export type PostPRCommentOpts = {
  /** Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/42 */
  prUrl: string;
  body: string;
  githubToken: string;
};

/**
 * Posts a comment on a GitHub PR using the gh CLI.
 * Parses the PR number and repo from the URL.
 * Throws if the URL cannot be parsed or gh fails.
 */
export async function postPRComment(
  opts: PostPRCommentOpts,
  runGh: RunGh = defaultRunGh,
): Promise<void> {
  const { prUrl, body, githubToken } = opts;

  const match = prUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`[pr-helpers] Cannot parse PR URL: ${prUrl}`);
  }
  const owner = match[1]!;
  const repo = match[2]!;
  const prNumber = match[3]!;

  await runGh(['pr', 'comment', prNumber, '--repo', `${owner}/${repo}`, '--body', body], {
    env: { GITHUB_TOKEN: githubToken },
  });
}
