/**
 * Shared git/gh helpers used by both the artifact publisher (spec-publisher.ts)
 * and the code-workspace provisioner (code-workspace.ts).
 *
 * Extracted here to avoid duplicating token-sanitization and auth-URL logic
 * across specialists.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Injectable runner types ───────────────────────────────────────────────────

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

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Builds an HTTPS URL with the token embedded as basic-auth credentials.
 * Format: `https://x-access-token:{token}@github.com/{owner}/{repo}`
 *
 * This URL is used for `git clone` only.  The `origin` remote inside the
 * resulting clone stores this URL (including the token) in `.git/config`.
 * Since every publish/provision uses a fresh isolated directory that is deleted
 * in the `finally` block, the on-disk lifetime of the token is bounded to the
 * duration of a single operation.
 *
 * ⚠ NEVER pass this URL to logging calls.  Use the plain repo URL
 *   in user-visible messages; pass raw error text through `sanitizeToken`.
 */
export function buildAuthenticatedUrl(owner: string, repo: string, token: string): string {
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
export function sanitizeToken(text: string, token: string): string {
  return text
    .replaceAll(`x-access-token:${token}@`, 'x-access-token:***@')
    .replaceAll(token, '***');
}
