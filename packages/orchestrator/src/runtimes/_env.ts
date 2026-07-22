/**
 * Shared subprocess primitives for spawn-based runtimes (ClaudeCodeRuntime,
 * CodexRuntime, …). Extracted so each runtime reuses the same Bun.spawn
 * abstraction and the same credential-scrubbing logic without duplication.
 */

// ── Subprocess abstraction ────────────────────────────────────────────────────
// A minimal interface over Bun.Subprocess so tests can inject a fake process.
// The real implementation calls Bun.spawn; no bun-types dep is needed in this
// package because these runtimes only run inside apps/api (which has Bun).

export interface SubprocessLike {
  readonly stdout: ReadableStream<Uint8Array>;
  /** Captured stderr — used for diagnostics when no result line is emitted. */
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
}

export type SpawnFn = (
  args: string[],
  cwd: string,
  env: Record<string, string>,
  /**
   * Optional bytes to feed the subprocess over stdin. When provided, the spawn
   * writes them and closes the pipe (EOF), so a CLI that reads its prompt from
   * stdin proceeds without blocking. When omitted, stdin is `/dev/null`. Codex
   * uses this to pass large prompts off the argv (ARG_MAX); ClaudeCodeRuntime
   * leaves it unset and keeps the prompt on the command line. See ADR-028.
   */
  stdin?: Uint8Array,
) => SubprocessLike;

/**
 * Git credentials scrubbed from every spawn-based runtime's subprocess env.
 * A compromised agent subprocess must not be able to read the host's git token
 * via a tool call; the workspace is provisioned with the token out-of-band.
 */
export const GIT_CREDENTIAL_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * Extra secret-bearing keys commonly present in the Helm API process env.
 * Scrubbed from agent subprocesses so a compromised specialist cannot read
 * webhook secrets, tracker credentials, or other host secrets via tool calls.
 */
export const API_SECRET_KEYS = [
  ...GIT_CREDENTIAL_KEYS,
  'GITHUB_WEBHOOK_SECRET',
  'LINEAR_API_KEY',
  'LINEAR_WEBHOOK_SECRET',
  'LINEAR_OAUTH_CLIENT_SECRET',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_DSN',
  'AMPLITUDE_API_KEY',
  'GROWTHBOOK_CLIENT_KEY',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_DATABASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

/** Matches common secret-bearing env key suffixes/names beyond the explicit list. */
export const SECRET_ENV_KEY_PATTERN =
  /(?:^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|DATABASE_URL)$/i;

/**
 * Builds the subprocess environment from the host `process.env`, applying two
 * transformations:
 *
 *  1. **Credential scrub**: every key in `scrubKeys` is deleted, and any env
 *     key matching `SECRET_ENV_KEY_PATTERN` is deleted, so a compromised agent
 *     subprocess cannot exfiltrate host credentials via tool calls. Defaults to
 *     `API_SECRET_KEYS` (git tokens plus common API/webhook secrets). Runtimes
 *     may pass a wider list when they have provider credentials to strip
 *     (e.g. Codex strips OpenAI keys so subscription auth on disk is used).
 *
 *  2. **Extra env**: caller-provided key/value pairs are merged on top (used by
 *     specialists that need their own env vars).
 *
 * The scrub runs again *after* the merge so a caller that accidentally passes a
 * scrubbed key in `extra` cannot re-introduce the credential.
 *
 * Returns a plain `Record<string, string>` — all values are guaranteed to be
 * strings (undefined entries from `process.env` are filtered out).
 */
function scrubSecretKeys(env: Record<string, string>, scrubKeys: readonly string[]): void {
  for (const key of scrubKeys) delete env[key];
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_KEY_PATTERN.test(key)) delete env[key];
  }
}

export function buildSubprocessEnv(
  extra?: Record<string, string>,
  scrubKeys: readonly string[] = API_SECRET_KEYS,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // First scrub: remove credentials from host env before merging overrides.
  scrubSecretKeys(env, scrubKeys);
  // Merge caller-provided overrides last so they can set whatever the specialist needs.
  if (extra) Object.assign(env, extra);
  // Second scrub: prevent credential re-injection via the `extra` parameter.
  scrubSecretKeys(env, scrubKeys);
  return env;
}

/**
 * Default spawn: delegates to Bun.spawn with stdout and stderr piped.
 * Using globalThis cast to avoid a bun-types dev-dependency in this package.
 *
 * stdin handling — two modes, both giving the subprocess a definite EOF:
 *  - No `stdin` arg (ClaudeCodeRuntime): `'ignore'` maps stdin to /dev/null.
 *    The prompt rides on the command line; `codex exec`-style CLIs that read
 *    stdin to EOF ("Reading prompt from stdin…") get an immediate EOF and run.
 *  - With a `stdin` byte buffer (CodexRuntime, ADR-028): Bun writes the buffer
 *    and closes the pipe, so the CLI reads the whole prompt then sees EOF. This
 *    keeps large prompts off the argv (ARG_MAX) without hanging.
 *
 * Either way the pipe is closed — an inherited/never-closing stdin would block
 * the subprocess until the timeout.
 */
export function defaultSpawn(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stdin?: Uint8Array,
): SubprocessLike {
  const bun = (globalThis as Record<string, unknown>)['Bun'] as
    | {
        spawn(
          args: string[],
          options: {
            cwd: string;
            stdin: 'ignore' | Uint8Array;
            stdout: 'pipe';
            stderr: 'pipe';
            env: Record<string, string>;
          },
        ): SubprocessLike;
      }
    | undefined;
  if (!bun) throw new Error('Spawn-based runtimes require the Bun runtime');
  return bun.spawn(args, { cwd, stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe', env });
}
