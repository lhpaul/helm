/** Parsed outcome from review-adjudicator `adjudication.md` (ADR-037). */

export type AdjudicationStatus = 'AUTO_REMEDIATE' | 'HUMAN_REQUIRED';

export type ParsedAdjudication = {
  status: AdjudicationStatus;
  /** Unified plan section passed to code-remediator when status is AUTO_REMEDIATE. */
  unifiedPlan: string;
  /** Full markdown body (for PR comment and human escalation). */
  body: string;
  conflictsSection: string;
};

export const ADJUDICATION_MD_FORMAT = `# Review Adjudication: {externalId}

## Summary
<one paragraph>

## Conflicts
- **product_decision** · <title>
  <sources, tension, and recommended human options — omit entire section when none>
- **doc_conflict** · <title>
  <resolution per ADR > spec > CLAUDE.md, or escalate>

## Unified remediation plan
- **AUTO** · <actionable fix>
- **DEFERRED** · <finding> — <reason>

## Status
AUTO_REMEDIATE | HUMAN_REQUIRED

Use HUMAN_REQUIRED when any product_decision or unresolved doc_conflict remains.`.trim();

const STATUS_RE = /^##\s+Status\s*\n\s*(AUTO_REMEDIATE|HUMAN_REQUIRED)\b/im;

/**
 * Parses adjudication.md produced by the review-adjudicator specialist.
 * Defaults to HUMAN_REQUIRED when status is missing or ambiguous (safe fail).
 */
export function parseAdjudicationBody(body: string): ParsedAdjudication {
  const statusMatch = body.match(STATUS_RE);
  const status: AdjudicationStatus =
    statusMatch?.[1] === 'AUTO_REMEDIATE' ? 'AUTO_REMEDIATE' : 'HUMAN_REQUIRED';

  const unifiedPlan = extractSection(body, 'Unified remediation plan');
  const conflictsSection = extractSection(body, 'Conflicts');

  const hasConflictEntries =
    conflictsSection.length > 0 &&
    /\*\*(product_decision|doc_conflict)\*\*\s*·/i.test(conflictsSection);

  const resolvedStatus: AdjudicationStatus =
    status === 'AUTO_REMEDIATE' && hasConflictEntries ? 'HUMAN_REQUIRED' : status;

  return {
    body,
    conflictsSection,
    status: resolvedStatus,
    unifiedPlan,
  };
}

function extractSection(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im');
  const match = body.match(re);
  return match?.[1]?.trim() ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
