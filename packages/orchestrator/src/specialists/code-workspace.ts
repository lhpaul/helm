/**
 * Provisioning and PR-opening helpers for the implementer specialist.
 *
 * `provisionCodeWorkspace` — shallow-clones the code repo, creates the
 *   `helm/impl/{externalId}` branch, and returns the checkout path.
 *
 * `openCodePR` — stages all changes, commits as helm-bot, pushes the
 *   implementation branch, and opens an idempotent PR against the default branch.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { CodeRepo } from '@helm/shared';
import { implBranchName } from '@helm/shared';
import { parseGitHubRepoUrl } from './fetch-product-context.js';
import {
  buildAuthenticatedUrl,
  sanitizeToken,
  defaultRunGit,
  defaultRunGh,
  type RunGit,
  type RunGh,
} from './git-helpers.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProvisionWorkspaceOpts = {
  externalId: string;
  codeRepo: CodeRepo;
  /** GitHub personal access token (repo scope). */
  githubToken: string;
};

export type ProvisionWorkspaceResult = {
  /** Absolute path to the shallow-cloned, branch-checked-out workspace. */
  workspacePath: string;
  /** The branch name created: `helm/impl/{externalId}`. */
  branchName: string;
};

export type OpenCodePROpts = {
  externalId: string;
  codeRepo: CodeRepo;
  /** Absolute path to the workspace populated by the implementer agent. */
  workspacePath: string;
  /** GitHub personal access token (repo scope). */
  githubToken: string;
  /** Human-readable title for the PR. */
  prTitle: string;
  /** Markdown body for the PR. */
  prBody: string;
};

export type OpenCodePRResult = {
  prUrl: string;
};

// ── EXTERNAL_ID guard ─────────────────────────────────────────────────────────

const EXTERNAL_ID_SAFE = /^(?!\.)[A-Za-z0-9._-]+$/;

// ── provisionCodeWorkspace ────────────────────────────────────────────────────

/**
 * Shallow-clones the product's primary code repo into an isolated temporary
 * directory, creates the `helm/impl/{externalId}` branch, and returns the
 * workspace path.
 *
 * Design notes:
 * - `--depth 1` keeps clone time short; the implementer only needs the tip of
 *   the default branch as a starting point.
 * - The clone path is `os.tmpdir()/helm-impl-{externalId}-{uuid}` — fully
 *   isolated per-run.  The caller is responsible for cleanup (pass the path to
 *   `rm -rf` after the agent and PR steps complete).
 * - SSH URLs are rejected early; token auth requires HTTPS.
 *
 * @throws if the externalId is invalid, the URL is SSH, or any git step fails.
 */
export async function provisionCodeWorkspace(
  opts: ProvisionWorkspaceOpts,
  runGit: RunGit = defaultRunGit,
): Promise<ProvisionWorkspaceResult> {
  const { externalId, codeRepo, githubToken } = opts;

  if (!EXTERNAL_ID_SAFE.test(externalId)) {
    throw new Error(`[code-workspace] Invalid externalId: "${externalId}"`);
  }

  // SSH URLs are not supported for token-based authentication.
  if (codeRepo.url.startsWith('git@') || codeRepo.url.startsWith('ssh://')) {
    throw new Error(
      `[code-workspace] SSH code repo URLs are not supported for token-based auth. ` +
        `Use an HTTPS URL instead.`,
    );
  }

  const parsed = parseGitHubRepoUrl(codeRepo.url);
  if (!parsed) {
    throw new Error(`[code-workspace] Cannot parse code repo URL: ${codeRepo.url}`);
  }
  const { owner, repo } = parsed;

  const authenticatedUrl = buildAuthenticatedUrl(owner, repo, githubToken);
  const workspacePath = join(tmpdir(), `helm-impl-${externalId}-${randomUUID()}`);
  await mkdir(workspacePath, { recursive: true });

  // ── Step 1: Shallow clone ─────────────────────────────────────────────────
  try {
    await runGit(
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        codeRepo.default_branch,
        authenticatedUrl,
        workspacePath,
      ],
      { cwd: tmpdir() },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Clean up the empty directory we created before the clone
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `[code-workspace] Failed to clone code repo (${codeRepo.url}): ${sanitizeToken(raw, githubToken)}`,
    );
  }

  // ── Step 2: Create implementation branch ─────────────────────────────────
  const branch = implBranchName(externalId);
  try {
    await runGit(['checkout', '-B', branch], { cwd: workspacePath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `[code-workspace] Failed to create branch '${branch}': ${sanitizeToken(raw, githubToken)}`,
    );
  }

  // ── Step 3: Scrub token from .git/config ──────────────────────────────────
  // The clone used an authenticated URL (https://x-access-token:{token}@…).
  // Git stores that URL — token included — in .git/config as the origin remote.
  // The agent runs with bypassPermissions in this workspace and could read the
  // token via `cat .git/config` or `git remote -v`. Reset origin to the plain
  // (non-authenticated) URL so the token is not accessible on disk.
  // The push in openCodePR bypasses the origin remote and pushes directly to an
  // authenticated URL so it does not rely on this remote being authenticated.
  try {
    await runGit(['remote', 'set-url', 'origin', codeRepo.url], { cwd: workspacePath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `[code-workspace] Failed to strip token from git config: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  return { workspacePath, branchName: branch };
}

// ── openCodePR ────────────────────────────────────────────────────────────────

/**
 * Stages all changes in the workspace, commits as helm-bot, pushes the
 * implementation branch, and opens an idempotent PR.
 *
 * - If the agent made no changes (git status is clean), returns early with
 *   `prUrl: ''` so the caller can handle the no-changes case.
 * - If an open PR already exists for this branch, its URL is returned without
 *   creating a duplicate.
 *
 * @throws if any git/gh step fails (excluding the no-changes early return).
 */
export async function openCodePR(
  opts: OpenCodePROpts,
  runGit: RunGit = defaultRunGit,
  runGh: RunGh = defaultRunGh,
): Promise<OpenCodePRResult> {
  const { externalId, codeRepo, workspacePath, githubToken, prTitle, prBody } = opts;

  if (!EXTERNAL_ID_SAFE.test(externalId)) {
    throw new Error(`[code-workspace] Invalid externalId: "${externalId}"`);
  }

  const parsed = parseGitHubRepoUrl(codeRepo.url);
  if (!parsed) {
    throw new Error(`[code-workspace] Cannot parse code repo URL: ${codeRepo.url}`);
  }
  const { owner, repo } = parsed;
  const branchName = implBranchName(externalId);

  const gitEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: 'helm-bot',
    GIT_AUTHOR_EMAIL: 'helm-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'helm-bot',
    GIT_COMMITTER_EMAIL: 'helm-bot@users.noreply.github.com',
  };

  // ── Step 1: Check for changes ─────────────────────────────────────────────
  // Use `git status --porcelain` — empty output means nothing was modified.
  let statusOut: string;
  try {
    const result = await runGit(['status', '--porcelain'], { cwd: workspacePath });
    statusOut = result.stdout.trim();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[code-workspace] Failed to check git status: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  if (!statusOut) {
    // Agent made no changes — nothing to commit or push.
    return { prUrl: '' };
  }

  // ── Step 2: Stage all changes ─────────────────────────────────────────────
  try {
    await runGit(['add', '-A'], { cwd: workspacePath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`[code-workspace] Failed to stage changes: ${sanitizeToken(raw, githubToken)}`);
  }

  // ── Step 3: Commit ────────────────────────────────────────────────────────
  try {
    await runGit(
      [
        'commit',
        '-m',
        `feat: implement ${externalId}\n\nGenerated by Helm implementer specialist.`,
      ],
      { cwd: workspacePath, env: gitEnv },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[code-workspace] Failed to commit implementation: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  // ── Step 4: Push branch ───────────────────────────────────────────────────
  // Push directly to the authenticated URL rather than via the `origin` remote.
  // provisionCodeWorkspace strips the token from origin (sets it to the plain
  // URL) so the agent cannot read it from .git/config.  We re-inject the token
  // here — only for the push — so the push is authenticated.
  const pushUrl = buildAuthenticatedUrl(owner, repo, githubToken);
  try {
    await runGit(['push', pushUrl, `${branchName}:${branchName}`, '--force'], {
      cwd: workspacePath,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[code-workspace] Failed to push branch '${branchName}': ${sanitizeToken(raw, githubToken)}`,
    );
  }

  const ghEnv: NodeJS.ProcessEnv = { GITHUB_TOKEN: githubToken };

  // ── Step 5: Check for existing open PR (idempotent) ───────────────────────
  let existingPrUrl: string | null = null;
  try {
    const listOut = await runGh(
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
      { env: ghEnv },
    );
    const prs = JSON.parse(listOut.stdout.trim()) as { url: string }[];
    if (prs.length > 0) existingPrUrl = prs[0]!.url;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[code-workspace] Failed to check for existing PRs: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  if (existingPrUrl) {
    return { prUrl: existingPrUrl };
  }

  // ── Step 6: Create PR ─────────────────────────────────────────────────────
  let prUrl: string;
  try {
    const createOut = await runGh(
      [
        'pr',
        'create',
        '--repo',
        `${owner}/${repo}`,
        '--head',
        branchName,
        '--base',
        codeRepo.default_branch,
        '--title',
        prTitle,
        '--body',
        prBody,
      ],
      { env: ghEnv },
    );
    prUrl = createOut.stdout.trim();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`[code-workspace] Failed to create PR: ${sanitizeToken(raw, githubToken)}`);
  }

  return { prUrl };
}
