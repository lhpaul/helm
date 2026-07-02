import type { Product } from '@helm/shared';
import type { FetchFn } from '../specialists/fetch-product-context.js';
import { fetchRawFile, parseGitHubRepoUrl } from '../specialists/fetch-product-context.js';

export type FalsePositiveEntry = {
  title: string;
  pattern: string;
  rationale: string;
  matchesSummary: (summary: string) => boolean;
};

const FALSE_POSITIVES_PATH = 'false-positives.md';

/** Parses `helm-knowledge/false-positives.md` sections into matchable entries. */
export function parseFalsePositivesCatalog(markdown: string): FalsePositiveEntry[] {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const sections = normalized.split(/\n\s*---\s*\n/);
  const entries: FalsePositiveEntry[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.startsWith('# Code-review false positives')) continue;

    const titleMatch = trimmed.match(/^#{2,3}\s+(.+)$/m);
    const patternMatch = trimmed.match(/\*\*Pattern:\*\*\s*(.+)/);
    const rationaleMatch = trimmed.match(
      /\*\*Why it's a false positive:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/,
    );
    if (!patternMatch) continue;

    const title = titleMatch?.[1]?.trim() ?? 'Catalogued pattern';
    const pattern = patternMatch[1]!.trim();
    const rationale = (rationaleMatch?.[1] ?? 'Catalogued false positive.')
      .replace(/\s+/g, ' ')
      .trim();
    const patternNeedle = normalizeForMatch(pattern);

    entries.push({
      title,
      pattern,
      rationale,
      matchesSummary: (summary: string) => {
        const haystack = normalizeForMatch(summary);
        if (haystack.includes(patternNeedle)) return true;
        return significantTokenOverlap(patternNeedle, haystack);
      },
    });
  }

  return entries;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function significantTokenOverlap(pattern: string, summary: string): boolean {
  const patternTokens = pattern.split(' ').filter((t) => t.length > 4);
  if (patternTokens.length === 0) return false;
  const hits = patternTokens.filter((token) => summaryIncludesToken(summary, token));
  return hits.length >= Math.min(3, patternTokens.length);
}

/** Word-boundary token match — avoids `health` matching `unhealthy`. */
function summaryIncludesToken(summary: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(summary);
}

/** Fetches the product knowledge-repo false-positive catalog (best-effort). */
export async function fetchFalsePositivesCatalog(
  product: Product,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<FalsePositiveEntry[]> {
  const parsed = parseGitHubRepoUrl(product.knowledge_repo.url);
  if (!parsed) return [];

  const content = await fetchRawFile(
    parsed.owner,
    parsed.repo,
    product.knowledge_repo.default_branch,
    FALSE_POSITIVES_PATH,
    token,
    fetchFn,
  );
  if (!content) return [];
  return parseFalsePositivesCatalog(content);
}
