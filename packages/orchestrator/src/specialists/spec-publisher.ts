import { copyFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Product } from '@helm/shared';
import { parseGitHubRepoUrl } from './fetch-product-context.js';

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export type PublishSpecOpts = {
  externalId: string;
  product: Product;
  /** Absolute path to specs/{externalId}.md in the workdir. */
  specPath: string;
  /** GitHub personal access token (repo scope). */
  githubToken: string;
};

export type PublishSpecResult = {
  prUrl: string;
};

/**
 * Injectable runner for git commands — receives an arg list and cwd.
 * Resolves with stdout; throws on non-zero exit.
 */
export type RunGit = (
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

/**
 * Injectable runner for gh commands — receives an arg list.
 * Resolves with stdout; throws on non-zero exit.
 */
export type RunGh = (
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

// ── Default runners ───────────────────────────────────────────────────────────

export const defaultRunGit: RunGit = async (args, opts) => {
  // Resolve 'git' from PATH for portability (avoids hardcoding /usr/bin/git
  // which may differ on Linux containers, NixOS, Windows, or Homebrew setups).
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout };
};

export const defaultRunGh: RunGh = async (args, opts) => {
  const { stdout } = await execFileAsync('gh', args, {
    env: { ...process.env, ...opts.env },
  });
  return { stdout };
};

// ── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Builds an HTTPS URL with the token embedded as basic-auth credentials.
 * Format: `https://x-access-token:{token}@github.com/{owner}/{repo}`
 *
 * This URL is used for `git clone` only.  The `origin` remote inside the
 * resulting clone stores this URL (including the token) in `.git/config`.
 * Since every publish uses a fresh isolated temp directory that is deleted in
 * the `finally` block, the on-disk lifetime of the token is bounded to the
 * duration of a single publish operation.
 *
 * ⚠ NEVER pass this URL to logging calls.  Use the plain `knowledgeRepo.url`
 *   in user-visible messages; pass raw error text through `sanitizeToken`.
 */
function buildAuthenticatedUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}`;
}

/**
 * Redacts ALL occurrences of the token from a string so that git error messages
 * (which may echo the remote URL) are safe to surface to operators.
 *
 * Replaces both:
 *   - every `x-access-token:<token>@`  →  `x-access-token:***@`  (URL pattern)
 *   - every bare token string          →  `***`                    (safety net)
 *
 * Uses replaceAll so that multiple occurrences in a single message are all
 * redacted (e.g. a git error that echoes the URL twice, or a stack trace that
 * includes both the URL pattern and the raw token).
 */
function sanitizeToken(text: string, token: string): string {
  return text
    .replaceAll(`x-access-token:${token}@`, 'x-access-token:***@')
    .replaceAll(token, '***');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Publishes a spec file to the product's knowledge repo as a PR.
 *
 * **Isolation**: each call clones the knowledge repo into a fresh temporary
 * directory (under `os.tmpdir()`), performs all git operations there, and
 * removes the directory in a `finally` block.  This guarantees that two
 * concurrent publishes — even for the same product — never share a checkout
 * and cannot interleave git operations or corrupt each other's branches.
 *
 * Idempotency: if the branch `helm/spec/{externalId}` already has an open PR,
 * the branch is updated (force-pushed) and the existing PR URL is returned —
 * no duplicate PRs are created.
 *
 * @param opts      Publish options including product config, spec path, and token.
 * @param runGit    Injectable git runner (defaults to git via execFile).
 * @param runGh     Injectable gh runner (defaults to gh via execFile).
 */
export async function publishSpecToPR(
  opts: PublishSpecOpts,
  runGit: RunGit = defaultRunGit,
  runGh: RunGh = defaultRunGh,
): Promise<PublishSpecResult> {
  const { externalId, product, specPath, githubToken } = opts;

  // The (?!\.) lookahead rejects dot-segment values (`.`, `..`, `.hidden`, …)
  // in addition to the character-class restriction, preventing path traversal.
  const EXTERNAL_ID_SAFE = /^(?!\.)[A-Za-z0-9._-]+$/;
  if (!EXTERNAL_ID_SAFE.test(externalId)) {
    throw new Error(`[spec-publisher] Invalid externalId: "${externalId}"`);
  }

  const knowledgeRepo = product.knowledge_repo;
  const defaultBranch = knowledgeRepo.default_branch;
  const branchName = `helm/spec/${externalId}`;

  const parsed = parseGitHubRepoUrl(knowledgeRepo.url);
  if (!parsed) {
    throw new Error(`[spec-publisher] Cannot parse knowledge repo URL: ${knowledgeRepo.url}`);
  }
  const { owner, repo } = parsed;

  // SSH-format knowledge repo URLs (git@github.com:org/repo or ssh://...) are
  // not supported for token-based authentication.  Fail early with a clear
  // message rather than silently falling through to a confusing auth error.
  if (knowledgeRepo.url.startsWith('git@') || knowledgeRepo.url.startsWith('ssh://')) {
    throw new Error(
      `[spec-publisher] SSH knowledge repo URLs are not supported for token-based auth. ` +
        `Use an HTTPS URL (https://github.com/${owner}/${repo}) instead.`,
    );
  }

  // Build the authenticated clone URL once.  The token is embedded as basic-auth
  // credentials so that `git clone` works with all git versions without requiring
  // GIT_CONFIG env var support (added in Git 2.31).  The `origin` remote inside
  // the resulting clone inherits this URL, so `git push origin` is authenticated
  // without any additional configuration.
  //
  // ⚠ Never log `authenticatedUrl`.  Always use `knowledgeRepo.url` (the plain
  //   URL) in error text, and pass raw git error strings through `sanitizeToken`.
  const authenticatedUrl = buildAuthenticatedUrl(owner, repo, githubToken);

  // Each publish gets its own isolated working directory so that concurrent
  // publishes for the same product do not share a checkout and cannot interleave
  // git operations (checkout, add, commit, push).  The directory is always
  // removed in the finally block — whether the publish succeeds or fails.
  const workDir = join(tmpdir(), `helm-publish-${externalId}-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    // ── Step 1: Clone knowledge repo to isolated workdir ────────────────────
    // Use the authenticated URL so git can access private repos.  The plain URL
    // (without credentials) is used in the error message.
    try {
      await runGit(['clone', authenticatedUrl, workDir], { cwd: tmpdir() });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[spec-publisher] Failed to clone knowledge repo (${knowledgeRepo.url}): ${sanitizeToken(raw, githubToken)}`,
      );
    }

    // ── Step 2: Create or reset branch from default branch ──────────────────
    try {
      // -B creates the branch if absent, or resets it to HEAD if it already exists.
      await runGit(['checkout', '-B', branchName, `origin/${defaultBranch}`], {
        cwd: workDir,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[spec-publisher] Failed to create branch '${branchName}': ${sanitizeToken(raw, githubToken)}`,
      );
    }

    // ── Step 3: Copy spec into knowledge repo ────────────────────────────────
    const destDir = join(workDir, 'specs');
    const destPath = join(destDir, `${externalId}.md`);
    try {
      await mkdir(destDir, { recursive: true });
      await copyFile(specPath, destPath);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[spec-publisher] Failed to copy spec file: ${sanitizeToken(raw, githubToken)}`,
      );
    }

    // ── Step 4: Commit ───────────────────────────────────────────────────────
    const gitEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: 'helm-bot',
      GIT_AUTHOR_EMAIL: 'helm-bot@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'helm-bot',
      GIT_COMMITTER_EMAIL: 'helm-bot@users.noreply.github.com',
    };
    try {
      await runGit(['add', join('specs', `${externalId}.md`)], { cwd: workDir });
      await runGit(['commit', '--allow-empty', '-m', `docs(spec): add spec for ${externalId}`], {
        cwd: workDir,
        env: gitEnv,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`[spec-publisher] Failed to commit spec: ${sanitizeToken(raw, githubToken)}`);
    }

    // ── Step 5: Push branch ──────────────────────────────────────────────────
    // The `origin` remote already holds the authenticated URL from the clone step,
    // so no extra credentials are needed here.
    try {
      await runGit(['push', 'origin', `${branchName}:${branchName}`, '--force'], {
        cwd: workDir,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[spec-publisher] Failed to push branch '${branchName}': ${sanitizeToken(raw, githubToken)}`,
      );
    }

    // ── Step 6: Open PR (idempotent) ─────────────────────────────────────────
    const ghEnv: NodeJS.ProcessEnv = { GITHUB_TOKEN: githubToken };

    // Check for an existing open PR before creating a new one.
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
        `[spec-publisher] Failed to check for existing PRs: ${sanitizeToken(raw, githubToken)}`,
      );
    }

    if (existingPrUrl) {
      return { prUrl: existingPrUrl };
    }

    // No open PR exists — create one.
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
          defaultBranch,
          '--title',
          `docs(spec): add spec for ${externalId}`,
          '--body',
          `Spec generated by Helm for item \`${externalId}\` in product \`${product.product.slug}\`.\n\nReview and merge to advance the item to **spec-ready**.`,
        ],
        { env: ghEnv },
      );
      prUrl = createOut.stdout.trim();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`[spec-publisher] Failed to create PR: ${sanitizeToken(raw, githubToken)}`);
    }

    return { prUrl };
  } finally {
    // Always clean up the isolated workdir, even on error.
    // Swallow cleanup errors so they never mask the original failure.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
