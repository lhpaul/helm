import type { Product } from '@helm/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProductContext = {
  /** Truncated README.md from the primary code repo, or undefined if unavailable. */
  readme?: string;
  /** Truncated AGENT.md or CLAUDE.md from the primary code repo, or undefined. */
  agentMd?: string;
};

/** Injectable HTTP fetcher for testing — defaults to the global fetch. */
export type FetchFn = typeof fetch;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CHARS = 2000;
const TRUNCATION_SUFFIX = '\n\n[...truncated]';

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
    // Try AGENT.md first; fall back to CLAUDE.md.
    fetchRawFile(owner, repo, branch, 'AGENT.md', token, fetchFn).then((content) =>
      content !== null ? content : fetchRawFile(owner, repo, branch, 'CLAUDE.md', token, fetchFn),
    ),
  ]);

  return {
    readme: readmeRaw !== null ? truncate(readmeRaw) : undefined,
    agentMd: agentMdRaw !== null ? truncate(agentMdRaw) : undefined,
  };
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
