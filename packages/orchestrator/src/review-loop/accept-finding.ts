/**
 * Operator accept-finding marker (ADR-043 §4).
 *
 * ADR-037 gives a maintainer `<!-- helm:product-decision -->` to settle an
 * adjudicator *conflict*. LEA-246 had no conflict — one reviewer, one MEDIUM,
 * nobody opposing it — so the only ways out were to wait for the stop rule or to
 * intervene in the repo by hand. This marker is the missing lever:
 *
 *     <!-- helm:accept-finding -->
 *     **Finding title:** Unit smoke does not exercise Expo Router navigation
 *     **Severity:** MEDIUM
 *     **Rationale:** AC #4 closed on the Vitest smoke; Maestro is separate work.
 *
 * An accept is scoped to one item. A pattern worth suppressing product-wide
 * still belongs in `false-positives.md`, where it gets review.
 */
import type { NormalizedFinding } from '../external-review/types.js';
import { fingerprintFindingTitle } from './finding-fingerprint.js';

export const ACCEPT_FINDING_MARKER = '<!-- helm:accept-finding -->';

/** Severities an operator may accept. CRITICAL/HIGH stay on the conflict path. */
const ACCEPTABLE_SEVERITIES: ReadonlySet<string> = new Set(['MEDIUM', 'LOW', 'INFO']);

export type ParsedAcceptedFinding = {
  /** ADR-038 fingerprint of the title — this is what the loop matches on. */
  fingerprint: string;
  findingTitle: string;
  /** Uppercased when the operator supplied one; absent means "unstated". */
  severity?: string;
  rationale: string;
};

export type StoredAcceptedFinding = Omit<ParsedAcceptedFinding, never> & {
  recordedAt: string;
  source: {
    provider: 'github';
    owner: string;
    repo: string;
    prNumber: number;
    commentId?: number;
    authorLogin: string;
  };
};

/**
 * Parses an accept-finding PR comment. Returns `null` when the comment is not
 * one — a missing title or rationale is "not an accept", not an error, because
 * every PR comment reaches this parser.
 *
 * The marker is a soft hint, matching the product-decision parser: a comment
 * carrying the labeled fields is accepted without it, and the marker alone
 * (no fields) is not.
 */
export function parseAcceptFindingComment(body: string): ParsedAcceptedFinding | null {
  const findingTitle = fieldFromBody(body, ['Finding title', 'finding_title', 'Finding', 'Title']);
  const rationale = fieldFromBody(body, ['Rationale', 'rationale', 'Reason', 'Why']);
  if (!findingTitle || !rationale) return null;

  // Require the marker unless the comment is unambiguously shaped like an
  // accept: `Finding title:` alone is specific enough, `Title:` alone is not.
  const hasMarker = body.includes(ACCEPT_FINDING_MARKER);
  const hasExplicitField =
    /^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:\*\*)?Finding(?: title)?(?:\*\*)?\s*:/im.test(body);
  if (!hasMarker && !hasExplicitField) return null;

  const severity = fieldFromBody(body, ['Severity', 'severity'])?.toUpperCase();

  return {
    fingerprint: fingerprintFindingTitle(findingTitle),
    findingTitle,
    ...(severity ? { severity } : {}),
    rationale,
  };
}

/**
 * Whether an operator may accept this finding (ADR-043 §4 severity ceiling).
 *
 * An unstated severity is refused rather than assumed: the ceiling is the whole
 * safety property, and a comment that does not say what it is accepting must not
 * be able to clear a HIGH by omission.
 */
export function isAcceptableSeverity(severity: string | undefined): severity is string {
  return severity !== undefined && ACCEPTABLE_SEVERITIES.has(severity.toUpperCase());
}

/** Whether an accepted-finding record covers a reviewer finding title. */
export function acceptedFindingMatchesTitle(
  accepted: readonly { fingerprint: string }[],
  title: string,
): boolean {
  if (accepted.length === 0) return false;
  const fingerprint = fingerprintFindingTitle(title);
  return accepted.some((entry) => entry.fingerprint === fingerprint);
}

/** Whether an accepted-finding record covers an external normalized finding. */
export function acceptedFindingMatchesExternal(
  accepted: readonly { fingerprint: string }[],
  finding: NormalizedFinding,
): boolean {
  if (accepted.length === 0) return false;
  return [finding.summary, finding.id].some(
    (value) => value !== undefined && acceptedFindingMatchesTitle(accepted, value),
  );
}

function fieldFromBody(body: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(
      new RegExp(
        `^\\s*(?:[-*]\\s*)?(?:\\[[ xX]\\]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+?)\\s*(?:\\*\\*)?\\s*$`,
        'im',
      ),
    );
    const value = match?.[1]?.replace(/\*\*$/u, '').trim();
    if (value) return value;
  }
  return null;
}
