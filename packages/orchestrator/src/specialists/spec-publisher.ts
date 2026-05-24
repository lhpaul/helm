import { copyFile, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
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
  /** Absolute path where the knowledge repo should be cloned / already lives. */
  knowledgeRepoLocalPath: string;
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
  const { stdout } = await execFileAsync('/usr/bin/git', args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout };
};

export const defaultRunGh: RunGh = async (args, opts) => {
  const ghPath = '/opt/homebrew/bin/gh';
  const { stdout } = await execFileAsync(ghPath, args, {
    env: { ...process.env, ...opts.env },
  });
  return { stdout };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the knowledge repo is cloned and up to date.
 * If not yet cloned → git clone (with token-embedded HTTPS URL).
 * If already cloned → fetch + reset to latest default branch.
 */
async function ensureKnowledgeRepo(
  localPath: string,
  repoUrl: string,
  defaultBranch: string,
  githubToken: string,
  runGit: RunGit,
): Promise<void> {
  // Token-embedded URL so git doesn't prompt for credentials.
  const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${githubToken}@`);

  const gitDir = join(localPath, '.git');
  if (!(await pathExists(gitDir))) {
    await mkdir(dirname(localPath), { recursive: true });
    await runGit(['clone', authenticatedUrl, localPath], { cwd: dirname(localPath) });
  } else {
    // Pull latest without interactive prompts.
    await runGit(['fetch', 'origin'], { cwd: localPath });
    await runGit(['checkout', defaultBranch], { cwd: localPath });
    await runGit(['reset', '--hard', `origin/${defaultBranch}`], { cwd: localPath });
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Publishes a spec file to the product's knowledge repo as a PR.
 *
 * Idempotency: if the branch `helm/spec/{externalId}` already has an open PR,
 * the branch is updated (force-pushed) and the existing PR URL is returned —
 * no duplicate PRs are created.
 *
 * @param opts      Publish options including product config, spec path, and token.
 * @param runGit    Injectable git runner (defaults to /usr/bin/git via execFile).
 * @param runGh     Injectable gh runner (defaults to /opt/homebrew/bin/gh).
 */
export async function publishSpecToPR(
  opts: PublishSpecOpts,
  runGit: RunGit = defaultRunGit,
  runGh: RunGh = defaultRunGh,
): Promise<PublishSpecResult> {
  const { externalId, product, specPath, knowledgeRepoLocalPath, githubToken } = opts;

  const knowledgeRepo = product.knowledge_repo;
  const defaultBranch = knowledgeRepo.default_branch;
  const branchName = `helm/spec/${externalId}`;

  const parsed = parseGitHubRepoUrl(knowledgeRepo.url);
  if (!parsed) {
    throw new Error(`[spec-publisher] Cannot parse knowledge repo URL: ${knowledgeRepo.url}`);
  }
  const { owner, repo } = parsed;

  // ── Step 1: Clone or update knowledge repo ───────────────────────────────
  try {
    await ensureKnowledgeRepo(
      knowledgeRepoLocalPath,
      knowledgeRepo.url,
      defaultBranch,
      githubToken,
      runGit,
    );
  } catch (err) {
    throw new Error(
      `[spec-publisher] Failed to clone/update knowledge repo: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step 2: Create or reset branch from default branch ──────────────────
  try {
    // -B creates the branch if absent, or resets it to HEAD if it already exists.
    await runGit(['checkout', '-B', branchName, `origin/${defaultBranch}`], {
      cwd: knowledgeRepoLocalPath,
    });
  } catch (err) {
    throw new Error(
      `[spec-publisher] Failed to create branch '${branchName}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step 3: Copy spec into knowledge repo ────────────────────────────────
  const destDir = join(knowledgeRepoLocalPath, 'specs');
  const destPath = join(destDir, `${externalId}.md`);
  try {
    await mkdir(destDir, { recursive: true });
    await copyFile(specPath, destPath);
  } catch (err) {
    throw new Error(
      `[spec-publisher] Failed to copy spec file: ${err instanceof Error ? err.message : String(err)}`,
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
    await runGit(['add', join('specs', `${externalId}.md`)], { cwd: knowledgeRepoLocalPath });
    await runGit(['commit', '--allow-empty', '-m', `docs(spec): add spec for ${externalId}`], {
      cwd: knowledgeRepoLocalPath,
      env: gitEnv,
    });
  } catch (err) {
    throw new Error(
      `[spec-publisher] Failed to commit spec: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step 5: Push branch ──────────────────────────────────────────────────
  const authenticatedUrl = knowledgeRepo.url.replace(
    'https://',
    `https://x-access-token:${githubToken}@`,
  );
  try {
    await runGit(['push', authenticatedUrl, `${branchName}:${branchName}`, '--force'], {
      cwd: knowledgeRepoLocalPath,
    });
  } catch (err) {
    throw new Error(
      `[spec-publisher] Failed to push branch '${branchName}': ${err instanceof Error ? err.message : String(err)}`,
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
    throw new Error(
      `[spec-publisher] Failed to check for existing PRs: ${err instanceof Error ? err.message : String(err)}`,
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
    throw new Error(
      `[spec-publisher] Failed to create PR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { prUrl };
}
