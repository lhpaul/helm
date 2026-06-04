import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Product } from '@helm/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProductContext = {
  /** Truncated README.md from the primary code repo, or undefined if unavailable. */
  readme?: string;
  /** Truncated AGENT.md or CLAUDE.md from the primary code repo, or undefined. */
  agentMd?: string;
};

/**
 * Result of {@link materializeProductContext} — describes what was written to the
 * spec-writer / plan-writer worktree. `null` entries mean the file was absent in
 * the repo (best-effort posture — never a throw for a missing file).
 */
export interface MaterializedProductContext {
  /** The materialized README, or null if absent. `bytes` is the on-disk UTF-8 size. */
  readme: { path: string; bytes: number } | null;
  /**
   * The materialized agent instruction file, or null if none of the accepted
   * variants exist. `filename` preserves the variant that won the
   * {@link AGENT_INSTRUCTION_FILES} preference order (`AGENTS.md` / `AGENT.md` /
   * `CLAUDE.md`) — written to disk under its real name, no rename.
   */
  agentInstructions: { path: string; filename: string; bytes: number } | null;
  /** Names of accepted files that weren't found in the repo (informational; dispatcher logs). */
  missingFiles: string[];
}

/** Injectable HTTP fetcher for testing — defaults to the global fetch. */
export type FetchFn = typeof fetch;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CHARS = 2000;
const TRUNCATION_SUFFIX = '\n\n[...truncated]';

/**
 * Accepted "agent instructions" filenames, in preference order. `AGENTS.md`
 * (plural) is the cross-tool open standard (agentsmd.com); `AGENT.md` /
 * `CLAUDE.md` are accepted for compatibility. Single source of truth shared by
 * the product-context reader and the readiness gate (ADR-026) so they cannot
 * drift apart.
 */
export const AGENT_INSTRUCTION_FILES = ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'] as const;

/** Cap for spec/plan content fetched as specialist input. Generous — the artifact IS the input. */
const SPEC_MAX_CHARS = 32_000;
const SPEC_TRUNCATION_SUFFIX = '\n\n[...truncated — spec exceeds 32000 chars]';

const PLAN_MAX_CHARS = 32_000;
const PLAN_TRUNCATION_SUFFIX = '\n\n[...truncated — plan exceeds 32000 chars]';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses a GitHub URL into owner/repo.
 * Supports both HTTPS (`https://github.com/owner/repo[.git]`) and
 * SSH (`git@github.com:owner/repo[.git]`) formats.
 */
export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  // SSH format: git@github.com:owner/repo[.git]
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }

  // HTTPS format: https://github.com/owner/repo[.git][/]
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    if (parts.length < 2) return null;
    const owner = parts[0]!;
    const repo = parts[1]!.replace(/\.git$/, '');
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Fetches raw file content from GitHub via raw.githubusercontent.com.
 * Returns null on 404 (file does not exist).
 * Throws a descriptive error on any other non-2xx status (auth, server errors, etc.).
 * Throws on network errors.
 *
 * Exported so that other specialists (e.g. plan-writer's fetchSpecForPlan) can
 * reuse the same authenticated fetch logic without duplicating it.
 */
export async function fetchRawFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchRawFile: HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

function truncate(content: string): string {
  if (content.length <= MAX_CHARS) return content;
  return content.slice(0, MAX_CHARS) + TRUNCATION_SUFFIX;
}

/**
 * Returns the content of the first file in `paths` that exists (non-null),
 * or null if none do. Sequential to short-circuit on the first hit.
 */
async function fetchFirstFile(
  owner: string,
  repo: string,
  branch: string,
  paths: readonly string[],
  token: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  for (const path of paths) {
    const content = await fetchRawFile(owner, repo, branch, path, token, fetchFn);
    if (content !== null) return content;
  }
  return null;
}

/**
 * Like {@link fetchFirstFile}, but also reports *which* path matched. Needed when
 * the caller must preserve the winning filename (e.g. materializing the agent
 * instruction file under its real `AGENTS.md` / `AGENT.md` / `CLAUDE.md` variant).
 */
async function fetchFirstNamedFile(
  owner: string,
  repo: string,
  branch: string,
  paths: readonly string[],
  token: string,
  fetchFn: FetchFn,
): Promise<{ filename: string; content: string } | null> {
  for (const path of paths) {
    const content = await fetchRawFile(owner, repo, branch, path, token, fetchFn);
    if (content !== null) return { filename: path, content };
  }
  return null;
}

// ── Product context (README + agent instructions from code repo) ──────────────

/**
 * Fetches README and agent instructions from the product's primary code repo.
 * All fields are optional — a missing file is not an error.
 *
 * Design rationale: the spec-writer only needs to understand the domain, not
 * modify code. Fetching README + AGENT.md via the GitHub contents API is
 * sufficient and avoids the overhead of a full git clone (which is reserved
 * for the implementer specialist that needs to modify files).
 *
 * @param product  The parsed product config.
 * @param token    GitHub personal access token (repo scope).
 * @param fetchFn  HTTP fetch function — injectable for testing.
 */
export async function fetchProductContext(
  product: Product,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<ProductContext> {
  const primaryRepo = product.code_repos[0];
  if (!primaryRepo) return {};

  const parsed = parseGitHubRepoUrl(primaryRepo.url);
  if (!parsed) return {};

  const { owner, repo } = parsed;
  const branch = primaryRepo.default_branch;

  // Fetch README and agent instructions concurrently.
  const [readmeRaw, agentMdRaw] = await Promise.all([
    fetchRawFile(owner, repo, branch, 'README.md', token, fetchFn),
    // Agent instructions: AGENTS.md (open standard) → AGENT.md → CLAUDE.md.
    fetchFirstFile(owner, repo, branch, AGENT_INSTRUCTION_FILES, token, fetchFn),
  ]);

  return {
    readme: readmeRaw !== null ? truncate(readmeRaw) : undefined,
    agentMd: agentMdRaw !== null ? truncate(agentMdRaw) : undefined,
  };
}

// ── Materialize product context (write files into the worktree) ───────────────

/**
 * Writes the product's README and winning agent instruction file into `workdir`,
 * so the spec-writer / plan-writer agent can `cat`/`grep`/reference specific
 * sections from disk — not just the truncated `## Product Context` prompt
 * snippet (ADR-030). The spec-writer / plan-writer worktree is otherwise an empty
 * scratch directory (no git clone), unlike the implementer's shallow clone.
 *
 * Sibling of {@link fetchProductContext}, deliberately NOT a flag on it: the two
 * share the fetch helpers but expose distinct entry points so prompt-injection
 * callers are unaffected. Key differences from `fetchProductContext`:
 *
 *  - **No truncation on disk.** The full file is written (the prompt-injected
 *    version keeps its 2000-char cap for context-window economy).
 *  - **Filename preserved.** The agent instruction file is written under the real
 *    variant that won the {@link AGENT_INSTRUCTION_FILES} order — no rename.
 *  - **Best-effort, not throw-on-missing.** A 404 yields a `null` entry plus an
 *    entry in `missingFiles`; the worktree simply lacks that file. A non-404 HTTP
 *    error still propagates (via `fetchRawFile`) so the dispatcher can log it.
 *
 * @param workdir  Absolute path to the agent's worktree (already created).
 * @param product  The parsed product config.
 * @param token    GitHub personal access token (repo scope).
 * @param fetchFn  HTTP fetch function — injectable for testing.
 */
export async function materializeProductContext(
  workdir: string,
  product: Product,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<MaterializedProductContext> {
  // No reachable repo → nothing to materialize. Report every accepted file as
  // missing so the dispatcher log reflects an empty worktree, never silently "ok".
  const allMissing = (): MaterializedProductContext => ({
    readme: null,
    agentInstructions: null,
    missingFiles: ['README.md', ...AGENT_INSTRUCTION_FILES],
  });

  const primaryRepo = product.code_repos[0];
  if (!primaryRepo) return allMissing();

  const parsed = parseGitHubRepoUrl(primaryRepo.url);
  if (!parsed) return allMissing();

  const { owner, repo } = parsed;
  const branch = primaryRepo.default_branch;

  // Fetch README and the winning agent instruction file concurrently. A non-404
  // HTTP error rejects here and propagates to the caller (matches fetchRawFile).
  const [readmeRaw, agentFile] = await Promise.all([
    fetchRawFile(owner, repo, branch, 'README.md', token, fetchFn),
    fetchFirstNamedFile(owner, repo, branch, AGENT_INSTRUCTION_FILES, token, fetchFn),
  ]);

  const missingFiles: string[] = [];
  let readme: MaterializedProductContext['readme'] = null;
  let agentInstructions: MaterializedProductContext['agentInstructions'] = null;

  // README — full content, no truncation on disk.
  if (readmeRaw !== null) {
    const path = join(workdir, 'README.md');
    await writeFile(path, readmeRaw, 'utf8');
    readme = { path, bytes: Buffer.byteLength(readmeRaw, 'utf8') };
  } else {
    missingFiles.push('README.md');
  }

  // Agent instructions — written under the real winning variant name (no rename).
  if (agentFile !== null) {
    const path = join(workdir, agentFile.filename);
    await writeFile(path, agentFile.content, 'utf8');
    agentInstructions = {
      path,
      filename: agentFile.filename,
      bytes: Buffer.byteLength(agentFile.content, 'utf8'),
    };
  } else {
    // None of the accepted variants exist — report all of them as missing.
    missingFiles.push(...AGENT_INSTRUCTION_FILES);
  }

  // Spread-copy missingFiles so callers can't mutate our local array (matches the
  // defensive posture of allMissing() above and the repo's return-copy convention).
  return { readme, agentInstructions, missingFiles: [...missingFiles] };
}

// ── Spec fetch (for plan-writer) ──────────────────────────────────────────────

/**
 * Fetches the approved spec from the product's knowledge repo.
 *
 * The spec is the primary input for the plan-writer: it is fetched from
 * `specs/{externalId}.md` on the knowledge repo's default branch.
 *
 * Unlike product context, the spec is NOT truncated aggressively — a 32 000-char
 * cap is applied as a generous safety limit rather than a tight budget.
 *
 * Returns null when the spec file is absent (404) or the repo URL cannot be parsed.
 * Throws on network errors so the dispatcher can propagate the failure rather than
 * silently proceeding without the spec.
 *
 * @param product     The parsed product config.
 * @param externalId  The item identifier.
 * @param token       GitHub personal access token (repo scope).
 * @param fetchFn     HTTP fetch function — injectable for testing.
 */
const EXTERNAL_ID_SAFE = /^(?!\.)[A-Za-z0-9._-]+$/;

export async function fetchSpecForPlan(
  product: Product,
  externalId: string,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<string | null> {
  if (!EXTERNAL_ID_SAFE.test(externalId)) {
    throw new Error(`[fetch-spec] Invalid externalId: "${externalId}"`);
  }

  const parsed = parseGitHubRepoUrl(product.knowledge_repo.url);
  if (!parsed) return null;

  const { owner, repo } = parsed;
  const branch = product.knowledge_repo.default_branch;

  const content = await fetchRawFile(owner, repo, branch, `specs/${externalId}.md`, token, fetchFn);
  if (content === null) return null;

  if (content.length > SPEC_MAX_CHARS) {
    return content.slice(0, SPEC_MAX_CHARS) + SPEC_TRUNCATION_SUFFIX;
  }
  return content;
}

// ── Plan fetch (for implementer) ──────────────────────────────────────────────

/**
 * Fetches the approved plan from the product's knowledge repo.
 *
 * The plan is the primary input for the implementer: it is fetched from
 * `plans/{externalId}.md` on the knowledge repo's default branch.
 *
 * Mirror of `fetchSpecForPlan` — same 32 000-char cap, same null-on-404
 * semantics, same traversal guard on externalId.
 *
 * @param product     The parsed product config.
 * @param externalId  The item identifier.
 * @param token       GitHub personal access token (repo scope).
 * @param fetchFn     HTTP fetch function — injectable for testing.
 */
export async function fetchPlanForImplementer(
  product: Product,
  externalId: string,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<string | null> {
  if (!EXTERNAL_ID_SAFE.test(externalId)) {
    throw new Error(`[fetch-plan] Invalid externalId: "${externalId}"`);
  }

  const parsed = parseGitHubRepoUrl(product.knowledge_repo.url);
  if (!parsed) return null;

  const { owner, repo } = parsed;
  const branch = product.knowledge_repo.default_branch;

  const content = await fetchRawFile(owner, repo, branch, `plans/${externalId}.md`, token, fetchFn);
  if (content === null) return null;

  if (content.length > PLAN_MAX_CHARS) {
    return content.slice(0, PLAN_MAX_CHARS) + PLAN_TRUNCATION_SUFFIX;
  }
  return content;
}
