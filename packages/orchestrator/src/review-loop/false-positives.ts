import type { Product } from '@helm/shared';
import type { NormalizedFinding } from '../external-review/types.js';
import type { FetchFn } from '../specialists/fetch-product-context.js';
import { fetchRawFile, parseGitHubRepoUrl } from '../specialists/fetch-product-context.js';

export type FalsePositiveEntry = {
  title: string;
  pattern: string;
  rationale: string;
  appliesTo?: string[];
  source?: 'built-in' | 'remote';
  matchesSummary: (summary: string) => boolean;
};

const FALSE_POSITIVES_PATH = 'false-positives.md';
const BUILT_IN_FALSE_POSITIVES: readonly Omit<FalsePositiveEntry, 'matchesSummary'>[] = [
  {
    title: 'Pair spec and plan files sequencing',
    pattern: 'pair-spec-and-plan-files',
    appliesTo: ['spec-draft', 'plan-draft'],
    rationale:
      'Draft artifact review may see only one side of the spec/plan pair before the operator merges the current artifact PR.',
  },
  {
    title: 'Spec plan artifact ordering',
    pattern: 'plan file is missing while spec remains in spec-draft',
    appliesTo: ['spec-draft', 'plan-draft'],
    rationale:
      'Helm creates and reviews spec and plan artifacts sequentially; the downstream artifact can be absent during early review by design.',
  },
  {
    title: 'Plan spec artifact ordering',
    pattern: 'spec file is missing while plan remains in plan-draft',
    appliesTo: ['spec-draft', 'plan-draft'],
    rationale:
      'Helm creates and reviews spec and plan artifacts sequentially; the paired artifact can be absent during early review by design.',
  },
];

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
    const appliesToMatch = trimmed.match(/\*\*Applies to:\*\*\s*(.+)/);
    const rationaleMatch = trimmed.match(
      /\*\*Why it's a false positive:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/,
    );
    if (!patternMatch) continue;

    const title = titleMatch?.[1]?.trim() ?? 'Catalogued pattern';
    const pattern = patternMatch[1]!.trim();
    const rationale = (rationaleMatch?.[1] ?? 'Catalogued false positive.')
      .replace(/\s+/g, ' ')
      .trim();
    const appliesTo = appliesToMatch?.[1]
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const patternNeedle = normalizeForMatch(pattern);

    entries.push({
      title,
      pattern,
      rationale,
      appliesTo,
      source: 'remote',
      matchesSummary: (summary: string) => {
        const haystack = normalizeForMatch(summary);
        if (haystack.includes(patternNeedle)) return true;
        return significantTokenOverlap(patternNeedle, haystack);
      },
    });
  }

  return entries;
}

export function builtInFalsePositiveEntries(): FalsePositiveEntry[] {
  return BUILT_IN_FALSE_POSITIVES.map((entry) => {
    const patternNeedle = normalizeForMatch(entry.pattern);
    return {
      ...entry,
      appliesTo: entry.appliesTo ? [...entry.appliesTo] : undefined,
      source: 'built-in',
      matchesSummary: (summary: string) => {
        const haystack = normalizeForMatch(summary);
        if (haystack.includes(patternNeedle)) return true;
        return allSignificantTokensMatch(patternNeedle, haystack);
      },
    };
  });
}

export function matchesFalsePositiveFinding(
  entry: FalsePositiveEntry,
  finding: NormalizedFinding,
): boolean {
  return structuredFindingFields(finding).some((value) => entry.matchesSummary(value));
}

function structuredFindingFields(finding: NormalizedFinding): string[] {
  return [finding.id, finding.summary, finding.path, finding.detail, finding.fixHint].filter(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );
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

function allSignificantTokensMatch(pattern: string, summary: string): boolean {
  const patternTokens = pattern.split(' ').filter((t) => t.length >= 4);
  if (patternTokens.length === 0) return false;
  return patternTokens.every((token) => summaryIncludesToken(summary, token));
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
  if (!parsed) return builtInFalsePositiveEntries();

  const content = await fetchRawFile(
    parsed.owner,
    parsed.repo,
    product.knowledge_repo.default_branch,
    FALSE_POSITIVES_PATH,
    token,
    fetchFn,
  ).catch(() => null);
  if (!content) return builtInFalsePositiveEntries();
  return [...builtInFalsePositiveEntries(), ...parseFalsePositivesCatalog(content)];
}
