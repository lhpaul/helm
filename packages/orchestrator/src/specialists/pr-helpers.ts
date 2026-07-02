/**
 * PR-finding and PR-commenting helpers for reviewer specialists.
 *
 * `findCodePRUrl` — queries GitHub via gh CLI for the open `helm/impl/{externalId}`
 *   PR; returns null if no open PR exists (implementer hasn't opened one, or it
 *   was closed). GitHub is the source of truth — no ItemState lookup needed.
 *
 * `findArtifactPRUrl` — the knowledge-repo analogue of `findCodePRUrl`: queries
 *   GitHub for the open `helm/spec/{externalId}` or `helm/plan/{externalId}` PR.
 *   Used by the early-stage remediators (ADR-024) to locate the PR they iterate
 *   in-place. Same "GitHub is the source of truth" contract — the dispatcher
 *   only receives DispatchInput (no transition note carrying the PR URL).
 *
 * `postPRComment` — posts a review comment on a GitHub PR as the orchestrator
 *   (GITHUB_TOKEN never enters agent subprocesses).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeRepo, Product } from '@helm/shared';
import { implBranchName, specBranchName, planBranchName } from '@helm/shared';
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

// ── findArtifactPRUrl ─────────────────────────────────────────────────────────

/** Knowledge-repo artifact kinds that have a remediation flow (ADR-024). */
export type ArtifactPRKind = 'spec' | 'plan';

export type FindArtifactPROpts = {
  knowledgeRepo: Product['knowledge_repo'];
  externalId: string;
  /** 'spec' → helm/spec/{id}; 'plan' → helm/plan/{id}. */
  kind: ArtifactPRKind;
  githubToken: string;
};

/**
 * Finds the URL of the open spec or plan PR for the given item by querying
 * GitHub via gh CLI. Returns null if no open PR exists (artifact was never
 * published, or its PR was merged/closed). Throws on unexpected gh errors.
 *
 * Mirrors {@link findCodePRUrl} for the knowledge repo — GitHub is the source
 * of truth, so the early-stage remediators do not need an ItemState lookup.
 */
export async function findArtifactPRUrl(
  opts: FindArtifactPROpts,
  runGh: RunGh = defaultRunGh,
): Promise<string | null> {
  const { knowledgeRepo, externalId, kind, githubToken } = opts;

  const parsed = parseGitHubRepoUrl(knowledgeRepo.url);
  if (!parsed) {
    throw new Error(`[pr-helpers] Cannot parse knowledge repo URL: ${knowledgeRepo.url}`);
  }
  const { owner, repo } = parsed;
  const branchName = kind === 'spec' ? specBranchName(externalId) : planBranchName(externalId);

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

export type ParsedPRUrl = {
  owner: string;
  repo: string;
  prNumber: string;
};

export function parsePRUrl(prUrl: string): ParsedPRUrl | null {
  const match = prUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, prNumber: match[3]! };
}

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

  const parsed = parsePRUrl(prUrl);
  if (!parsed) {
    throw new Error(`[pr-helpers] Cannot parse PR URL: ${prUrl}`);
  }
  const { owner, repo, prNumber } = parsed;

  await runGh(['pr', 'comment', prNumber, '--repo', `${owner}/${repo}`, '--body', body], {
    env: { GITHUB_TOKEN: githubToken },
  });
}

export type UpsertPRCommentByMarkerOpts = PostPRCommentOpts & {
  /** HTML comment marker used to find an existing orchestrator comment. */
  marker: string;
};

/**
 * Creates or updates a PR comment identified by a stable HTML marker (ADR-036 summary).
 */
export async function upsertPRCommentByMarker(
  opts: UpsertPRCommentByMarkerOpts,
  runGh: RunGh = defaultRunGh,
): Promise<void> {
  const parsed = parsePRUrl(opts.prUrl);
  if (!parsed) {
    throw new Error(`[pr-helpers] Cannot parse PR URL: ${opts.prUrl}`);
  }

  const { owner, repo, prNumber } = parsed;
  const repoSlug = `${owner}/${repo}`;

  const listResult = await runGh(
    ['api', `repos/${repoSlug}/issues/${prNumber}/comments`, '--paginate'],
    { env: { GITHUB_TOKEN: opts.githubToken } },
  );

  const comments = parseGhIssueComments(listResult.stdout);
  const existing = comments
    .filter((comment) => (comment.body ?? '').includes(opts.marker))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    .at(-1);

  if (existing) {
    const payloadDir = await mkdtemp(join(tmpdir(), 'helm-pr-comment-'));
    const payloadPath = join(payloadDir, 'payload.json');
    try {
      await writeFile(payloadPath, JSON.stringify({ body: opts.body }));
      await runGh(
        [
          'api',
          `repos/${repoSlug}/issues/comments/${existing.id}`,
          '--method',
          'PATCH',
          '--input',
          payloadPath,
        ],
        { env: { GITHUB_TOKEN: opts.githubToken } },
      );
    } finally {
      await rm(payloadDir, { recursive: true, force: true });
    }
    return;
  }

  await postPRComment(opts, runGh);
}

function parseGhIssueComments(stdout: string): Array<{
  id: number;
  body?: string;
  created_at?: string;
}> {
  type GhComment = { id: number; body?: string; created_at?: string };

  const normalize = (value: unknown): GhComment[] => {
    if (!Array.isArray(value)) return [];
    if (value.length > 0 && Array.isArray(value[0])) {
      return value.flat() as GhComment[];
    }
    return value as GhComment[];
  };

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    return normalize(JSON.parse(trimmed));
  } catch {
    const merged: GhComment[] = [];
    for (const chunk of trimmed.split(/\n(?=\[)/)) {
      if (!chunk.trim()) continue;
      try {
        merged.push(...normalize(JSON.parse(chunk)));
      } catch {
        // Skip malformed paginated chunks — treat as no matching comment.
      }
    }
    return merged;
  }
}
