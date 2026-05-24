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
 * Returns null on 404 or any non-2xx response (treated as "file does not exist").
 * Throws on network errors.
 */
async function fetchRawFile(
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
  if (!res.ok) return null;
  return res.text();
}

function truncate(content: string): string {
  if (content.length <= MAX_CHARS) return content;
  return content.slice(0, MAX_CHARS) + TRUNCATION_SUFFIX;
}

// ── Main export ───────────────────────────────────────────────────────────────

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
