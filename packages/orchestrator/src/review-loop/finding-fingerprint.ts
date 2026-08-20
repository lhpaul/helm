import type { RemediateSeverity } from './remediate-gate.js';
import type { ReviewerResult } from '../specialists/reviewer-fanout.js';

const GATE_SEVERITIES: Record<RemediateSeverity, ReadonlySet<string>> = {
  critical_high: new Set(['CRITICAL', 'HIGH']),
  medium_and_above: new Set(['CRITICAL', 'HIGH', 'MEDIUM']),
};

/**
 * Sticky theme *groups* (ADR-043 §2). A group describes a subject where
 * reviewers habitually restate the same ask in different words across cycles.
 * When a title matches any member pattern, the group id becomes the whole
 * fingerprint — no paths, no title tokens — so a cycle-1 Expo Router ask and a
 * cycle-2 Maestro ask read as one unresolved finding instead of two.
 *
 * This over-merges on purpose: every test-fidelity finding on a PR collapses to
 * one fingerprint. That is the safe direction under ADR-038 §2 ("under-counting
 * sticky remaining is safer than false progress") — merging can only make
 * `no_progress` fire earlier, which is the point.
 *
 * Groups are Helm built-ins, not product config: a group id silently merges
 * distinct findings, so a new one is a code change with churn evidence.
 */
const STICKY_THEME_GROUPS: ReadonlyArray<{
  id: string;
  members: ReadonlyArray<{ id: string; pattern: RegExp }>;
}> = [
  {
    id: 'test-fidelity',
    members: [
      // Deliberately narrow: `expo` or `unit` alone must not pull an unrelated
      // finding into the group, since the group id erases everything else.
      { id: 'e2e-coverage', pattern: /\b(e2e|end[-\s]?to[-\s]?end)\b/i },
      { id: 'expo-router', pattern: /\bexpo[-\s]?router\b/i },
      { id: 'maestro', pattern: /\bmaestro\b/i },
      {
        id: 'unit-smoke',
        pattern:
          /\b(unit[-\s]?smoke|smoke[-\s]?tests?)\b|\bunit tests?\b[^.]{0,40}\b(instead of|rather than|not enough|insufficient|do(?:es)? not (?:exercise|render|cover))\b/i,
      },
    ],
  },
];

export type StickyThemeMatch = { groupId: string; memberIds: string[] };

/**
 * Returns the sticky theme group a title belongs to, or `null`.
 * Exported so callers can explain a fingerprint without re-deriving it.
 */
export function matchStickyThemeGroup(title: string): StickyThemeMatch | null {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const group of STICKY_THEME_GROUPS) {
    const memberIds = group.members
      .filter((member) => member.pattern.test(normalized))
      .map((member) => member.id);
    if (memberIds.length > 0) {
      return { groupId: group.id, memberIds };
    }
  }
  return null;
}

/** Synonym themes so sticky findings survive title rewording across cycles. */
const THEME_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  {
    id: 'tenant-isolation',
    pattern: /\b(rls|tenant[-\s]?isolation|cross[-\s]?tenant|another tenant|tenant[-\s]?scoped)\b/i,
  },
  {
    id: 'empty-state',
    pattern: /\b(empty[-\s]?state|zero[-\s]?state|no properties|empty (arrays?|payload|list))\b/i,
  },
  {
    id: 'uf-currency',
    pattern:
      /\buf\b[^.]{0,40}\b(currency|amount|common[-\s]?expenses?)\b|\b(currency|amount|common[-\s]?expenses?)\b[^.]{0,40}\buf\b/i,
  },
  {
    id: 'vacated-property',
    pattern: /\b(vacat|inactive contact|includeInactive)\b/i,
  },
  {
    id: 'response-contract',
    pattern: /\b(core_\*|mirror field|response (shape|contract)|schema)\b/i,
  },
  {
    id: 'payment-redirect',
    pattern: /\b(redirect|payment url|http(s)?)\b/i,
  },
];

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'for',
  'on',
  'in',
  'is',
  'are',
  'be',
  'with',
  'from',
  'that',
  'this',
  'not',
  'no',
  'only',
  'still',
  'missing',
  'incomplete',
]);

export type ParsedFinding = {
  fingerprint: string;
  severity: string;
  title: string;
};

/**
 * Extracts gate-severity finding titles from a review.md body and returns
 * stable fingerprints (path/theme keyed — not free-form summary prose).
 */
export function parseFindingFingerprints(
  reviewBody: string,
  severity: RemediateSeverity = 'critical_high',
): ParsedFinding[] {
  const allowed = GATE_SEVERITIES[severity];
  const findings: ParsedFinding[] = [];
  const re = /\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*\s*·\s*([^\n]+)/g;
  for (const match of reviewBody.matchAll(re)) {
    const sev = match[1]!;
    if (!allowed.has(sev)) continue;
    const title = match[2]!.trim();
    findings.push({
      fingerprint: fingerprintFindingTitle(title),
      severity: sev,
      title,
    });
  }
  return findings;
}

/** Collects unique fingerprints across reviewer comment bodies at gate severity. */
export function collectGateFindingFingerprints(
  results: ReviewerResult[],
  severity: RemediateSeverity = 'critical_high',
): Set<string> {
  const fingerprints = new Set<string>();
  for (const result of results) {
    if (!result.commentBody) continue;
    for (const finding of parseFindingFingerprints(result.commentBody, severity)) {
      fingerprints.add(finding.fingerprint);
    }
  }
  return fingerprints;
}

/**
 * How many sticky fingerprints from a prior cycle are still present.
 * Returns 0 when there is no sticky baseline yet.
 */
export function countStickyRemaining(
  stickyBaseline: ReadonlySet<string> | null,
  current: ReadonlySet<string>,
): number {
  if (stickyBaseline === null || stickyBaseline.size === 0) {
    return 0;
  }
  let remaining = 0;
  for (const id of stickyBaseline) {
    if (current.has(id)) remaining += 1;
  }
  return remaining;
}

/**
 * Per-source sticky tracker. Internal fan-out fingerprints and external
 * NormalizedFinding.id values live in different identifier spaces — never
 * share one baseline across both (ADR-038).
 */
export type StickyLane = {
  baseline: Set<string> | null;
  bestRemaining: number | null;
};

export function createStickyLane(): StickyLane {
  return { baseline: null, bestRemaining: null };
}

/**
 * Observes the current fingerprint set for one lane and returns stickyRemaining.
 * Initializes the baseline on first observation.
 */
export function observeStickyLane(lane: StickyLane, current: ReadonlySet<string>): number {
  if (lane.baseline === null) {
    lane.baseline = new Set(current);
  }
  return countStickyRemaining(lane.baseline, current);
}

/** Records a new best sticky-remaining value when improved. */
export function recordStickyImprovement(lane: StickyLane, stickyRemaining: number): void {
  if (lane.bestRemaining === null || stickyRemaining < lane.bestRemaining) {
    lane.bestRemaining = stickyRemaining;
  }
}

/**
 * Stable fingerprint for a finding title.
 * Prefer theme ids and repo paths over verbatim wording so cycle-to-cycle
 * rewrites of the same gap do not look like "new" progress.
 */
export function fingerprintFindingTitle(title: string): string {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  // Sticky theme groups short-circuit composition (ADR-043 §2): the group id is
  // the fingerprint, so restatements that swap members still collide.
  const stickyGroup = matchStickyThemeGroup(normalized);
  if (stickyGroup) return stickyGroup.groupId;

  const themes = THEME_PATTERNS.filter((theme) => theme.pattern.test(normalized)).map(
    (theme) => theme.id,
  );
  const paths = [...normalized.matchAll(/[a-z0-9._/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|md)/g)].map(
    (m) => m[0],
  );
  const tokens = normalized
    .replace(/[^a-z0-9./_\s-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .slice(0, 6);

  const parts = [...themes, ...paths.slice(0, 2), ...tokens];
  return parts.join('|') || normalized.slice(0, 48);
}
