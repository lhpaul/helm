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

export type SpawnFn = (args: string[], cwd: string, env: Record<string, string>) => SubprocessLike;

/**
 * Git credentials scrubbed from every spawn-based runtime's subprocess env.
 * A compromised agent subprocess must not be able to read the host's git token
 * via a tool call; the workspace is provisioned with the token out-of-band.
 */
export const GIT_CREDENTIAL_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * Builds the subprocess environment from the host `process.env`, applying two
 * transformations:
 *
 *  1. **Credential scrub**: every key in `scrubKeys` is deleted so a compromised
 *     agent subprocess cannot exfiltrate the host's credentials via tool calls.
 *     Defaults to `GIT_CREDENTIAL_KEYS`; runtimes pass a wider list when they
 *     have their own provider credentials to strip (e.g. Codex strips the OpenAI
 *     keys so subscription auth on disk is used and API keys cannot leak).
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
export function buildSubprocessEnv(
  extra?: Record<string, string>,
  scrubKeys: readonly string[] = GIT_CREDENTIAL_KEYS,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // First scrub: remove credentials from host env before merging overrides.
  for (const key of scrubKeys) delete env[key];
  // Merge caller-provided overrides last so they can set whatever the specialist needs.
  if (extra) Object.assign(env, extra);
  // Second scrub: prevent credential re-injection via the `extra` parameter.
  for (const key of scrubKeys) delete env[key];
  return env;
}

/**
 * Default spawn: delegates to Bun.spawn with stdout and stderr piped.
 * Using globalThis cast to avoid a bun-types dev-dependency in this package.
 */
export function defaultSpawn(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): SubprocessLike {
  const bun = (globalThis as Record<string, unknown>)['Bun'] as
    | {
        spawn(
          args: string[],
          options: { cwd: string; stdout: 'pipe'; stderr: 'pipe'; env: Record<string, string> },
        ): SubprocessLike;
      }
    | undefined;
  if (!bun) throw new Error('Spawn-based runtimes require the Bun runtime');
  return bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', env });
}
