import type { Product } from '@helm/shared';
import {
  parseGitHubRepoUrl,
  fetchRawFile,
  AGENT_INSTRUCTION_FILES,
  type FetchFn,
} from './specialists/fetch-product-context.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** One under-documented (or unverifiable) app repo surfaced by the gate. */
export type MissingContextEntry = {
  /** `owner/repo` when the URL parses, else the raw configured URL. */
  repo: string;
  role: 'app';
  /** Human-readable identifiers of what is missing or could not be verified. */
  missing: string[];
};

export type ReadinessResult = {
  ready: boolean;
  missingContext: MissingContextEntry[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_INSTRUCTIONS_LABEL = `agent instructions (one of: ${AGENT_INSTRUCTION_FILES.join(', ')})`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** `owner/repo` when parseable, else the raw URL — used for diagnostics only. */
function repoLabel(url: string): string {
  const parsed = parseGitHubRepoUrl(url);
  return parsed ? `${parsed.owner}/${parsed.repo}` : url;
}

/** True iff the file exists (non-null content). 404 → false; other errors throw. */
async function fileExists(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token: string,
  fetchFn: FetchFn,
): Promise<boolean> {
  const content = await fetchRawFile(owner, repo, branch, path, token, fetchFn);
  return content !== null;
}

/** True iff any of the accepted agent-instruction files exist. Short-circuits. */
async function hasAgentInstructions(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  fetchFn: FetchFn,
): Promise<boolean> {
  for (const file of AGENT_INSTRUCTION_FILES) {
    if (await fileExists(owner, repo, branch, file, token, fetchFn)) return true;
  }
  return false;
}

async function checkRepo(
  repo: { url: string; default_branch: string },
  token: string,
  fetchFn: FetchFn,
): Promise<MissingContextEntry | null> {
  const parsed = parseGitHubRepoUrl(repo.url);
  if (!parsed) {
    return {
      repo: repo.url,
      role: 'app',
      missing: ['unverifiable — could not parse GitHub repo URL'],
    };
  }

  const { owner, repo: name } = parsed;
  const branch = repo.default_branch;

  const [hasReadme, hasAgentMd] = await Promise.all([
    fileExists(owner, name, branch, 'README.md', token, fetchFn),
    hasAgentInstructions(owner, name, branch, token, fetchFn),
  ]);

  const missing: string[] = [];
  if (!hasReadme) missing.push('README.md');
  if (!hasAgentMd) missing.push(AGENT_INSTRUCTIONS_LABEL);

  return missing.length > 0 ? { repo: `${owner}/${name}`, role: 'app', missing } : null;
}

// ── Readiness check ─────────────────────────────────────────────────────────────

/**
 * Pre-dispatch product-readiness check (ADR-026). Verifies that every app-role
 * code repo carries the minimum context the spec-writer reads — a README and
 * agent instructions — so the spec-writer fails loudly (caller maps a non-ready
 * result to `422 missing_context`) instead of inventing from an under-documented
 * repo.
 *
 * Scope: only `role: 'app'` repos are checked; `docs` / `infra` repos are
 * exempt. The caller gates only the spec-writer entry (discovery → spec-draft);
 * later stages operate on structured artifacts, not raw repo docs (ADR-026).
 *
 * Mechanics: reuses the same `raw.githubusercontent` fetch primitive as
 * `fetchProductContext` (no clone). A 404 means the file is absent; any other
 * non-2xx or network error **propagates** so the caller can distinguish a
 * precondition failure (422) from an infrastructure failure (502).
 *
 * @param product  parsed product config
 * @param token    GitHub PAT (repo scope). When undefined, repos cannot be
 *                 verified and are reported as unverifiable (not silently ok).
 * @param fetchFn  injectable HTTP fetch — defaults to the global `fetch`.
 */
export async function checkProductReadiness(
  product: Product,
  token: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<ReadinessResult> {
  const appRepos = product.code_repos.filter((r) => r.role === 'app');

  if (appRepos.length === 0) {
    // Nothing the spec-writer reads from a code repo — vacuously ready.
    return { ready: true, missingContext: [] };
  }

  if (!token) {
    return {
      ready: false,
      missingContext: appRepos.map((r) => ({
        repo: repoLabel(r.url),
        role: 'app' as const,
        missing: ['unverifiable — GITHUB_TOKEN not configured'],
      })),
    };
  }

  const results = await Promise.all(appRepos.map((r) => checkRepo(r, token, fetchFn)));
  const missingContext = results.filter((r): r is MissingContextEntry => r !== null);

  return { ready: missingContext.length === 0, missingContext };
}
