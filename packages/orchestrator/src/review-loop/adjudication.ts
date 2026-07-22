/** Parsed outcome from review-adjudicator `adjudication.md` (ADR-037). */

export type AdjudicationStatus = 'AUTO_REMEDIATE' | 'HUMAN_REQUIRED';

export type ParsedAdjudication = {
  status: AdjudicationStatus;
  /** Unified plan section passed to code-remediator when status is AUTO_REMEDIATE. */
  unifiedPlan: string;
  /** Full markdown body (for PR comment and human escalation). */
  body: string;
  conflictsSection: string;
  conflicts: AdjudicationConflict[];
};

export type ProductDecisionConflictKind = 'product_decision' | 'doc_conflict';

export type DecisionScope = {
  paths: string[];
  markers: string[];
};

export type AdjudicationConflict = {
  conflictKind: ProductDecisionConflictKind;
  conflictTitle: string;
  scope: DecisionScope;
  fingerprint: string;
  body: string;
};

export type NormalizedProductDecision = AdjudicationConflict & {
  chosenOption: string;
};

export type StoredResolvedProductDecision = Omit<NormalizedProductDecision, 'body'> & {
  body?: string;
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

  const conflicts = parseAdjudicationConflicts(conflictsSection);

  const hasConflictEntries = conflicts.length > 0;

  const resolvedStatus: AdjudicationStatus =
    status === 'AUTO_REMEDIATE' && hasConflictEntries ? 'HUMAN_REQUIRED' : status;

  return {
    body,
    conflicts,
    conflictsSection,
    status: resolvedStatus,
    unifiedPlan,
  };
}

export function parseHumanProductDecisionComment(body: string): NormalizedProductDecision | null {
  if (!body.includes('<!-- helm:product-decision -->')) return null;

  const markdownConflict = conflictFromDecisionMarkdown(body);
  const labeledConflict = conflictFromDecisionField(body);
  const conflictKind =
    markdownConflict?.conflictKind ??
    labeledConflict?.conflictKind ??
    normalizeConflictKind(fieldFromDecisionBody(body, ['Conflict kind', 'conflict_kind']));
  const conflictTitle =
    markdownConflict?.conflictTitle ??
    labeledConflict?.conflictTitle ??
    fieldFromDecisionBody(body, ['Conflict title', 'conflict_title', 'Topic', 'Title']);
  const chosenOption = fieldFromDecisionBody(body, [
    'Chosen option',
    'chosen_option',
    'Chosen',
    'Decision',
    'Selected option',
  ]);

  if (!conflictKind || !conflictTitle || !chosenOption) return null;

  const scope = extractDecisionScope(body);
  const fingerprint = decisionFingerprint({ conflictKind, conflictTitle, scope });
  return {
    conflictKind,
    conflictTitle: conflictTitle.trim(),
    chosenOption: chosenOption.trim(),
    scope,
    fingerprint,
    body: body.trim(),
  };
}

export function decisionMatchesLatestAdjudication(input: {
  externalId: string;
  decision: NormalizedProductDecision;
  adjudicationBodies: string[];
}): boolean {
  const latest = [...input.adjudicationBodies]
    .reverse()
    .map((body) => ({
      externalId: adjudicationExternalId(body),
      parsed: parseAdjudicationBody(body),
    }))
    .find((record) => record.externalId === input.externalId);
  if (!latest || latest.parsed.status !== 'HUMAN_REQUIRED') return false;

  const chosen = normalizeText(input.decision.chosenOption);
  return latest.parsed.conflicts.some((conflict) => {
    return (
      conflict.fingerprint === input.decision.fingerprint &&
      declaredConflictChoices(conflict.body).some((choice) => normalizeText(choice) === chosen)
    );
  });
}

export function suppressSettledConflicts(
  parsed: ParsedAdjudication,
  settledDecisions: readonly { fingerprint: string; chosenOption: string }[],
): ParsedAdjudication {
  if (parsed.status !== 'HUMAN_REQUIRED' || parsed.conflicts.length === 0) return parsed;

  const settled = new Set(settledDecisions.map((decision) => decision.fingerprint));
  const remainingConflicts = parsed.conflicts.filter(
    (conflict) => !settled.has(conflict.fingerprint),
  );
  if (remainingConflicts.length === parsed.conflicts.length) return parsed;

  const settledNotes = parsed.conflicts
    .filter((conflict) => settled.has(conflict.fingerprint))
    .map((conflict) => {
      const decision = settledDecisions.find((d) => d.fingerprint === conflict.fingerprint);
      return `- **SETTLED** · ${conflict.conflictTitle} — using recorded choice: ${decision?.chosenOption ?? 'recorded decision'}`;
    })
    .join('\n');

  const unifiedPlan = [parsed.unifiedPlan, settledNotes].filter(Boolean).join('\n');
  return {
    ...parsed,
    conflicts: remainingConflicts,
    conflictsSection: remainingConflicts.map((conflict) => conflict.body).join('\n\n'),
    status: remainingConflicts.length > 0 ? 'HUMAN_REQUIRED' : 'AUTO_REMEDIATE',
    unifiedPlan,
  };
}

function parseAdjudicationConflicts(conflictsSection: string): AdjudicationConflict[] {
  if (!conflictsSection.trim()) return [];

  const records: AdjudicationConflict[] = [];
  const lines = conflictsSection.split(/\r?\n/);
  let current: {
    conflictKind: ProductDecisionConflictKind;
    conflictTitle: string;
    lines: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    const scope = extractDecisionScope(body);
    records.push({
      conflictKind: current.conflictKind,
      conflictTitle: current.conflictTitle,
      scope,
      fingerprint: decisionFingerprint({
        conflictKind: current.conflictKind,
        conflictTitle: current.conflictTitle,
        scope,
      }),
      body,
    });
  };

  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s*\*\*(product_decision|doc_conflict)\*\*\s*·\s*(.+?)\s*$/i);
    if (match) {
      flush();
      const conflictKind = normalizeConflictKind(match[1]);
      if (!conflictKind) {
        current = null;
        continue;
      }
      current = {
        conflictKind,
        conflictTitle: match[2]?.trim() ?? '',
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return records.filter((record) => record.conflictTitle.length > 0);
}

function fieldFromDecisionBody(body: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = escapeRegExp(name);
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

function conflictFromDecisionMarkdown(
  body: string,
): Pick<NormalizedProductDecision, 'conflictKind' | 'conflictTitle'> | null {
  const match = body.match(
    /^\s*[-*]\s*(?:\[[ xX]\]\s*)?\*\*(product_decision|doc_conflict)\*\*\s*·\s*(.+?)\s*$/im,
  );
  const conflictKind = normalizeConflictKind(match?.[1]);
  const conflictTitle = match?.[2]?.trim();
  if (!conflictKind || !conflictTitle) return null;
  return { conflictKind, conflictTitle };
}

function conflictFromDecisionField(
  body: string,
): Pick<NormalizedProductDecision, 'conflictKind' | 'conflictTitle'> | null {
  const conflict = fieldFromDecisionBody(body, ['Conflict']);
  const match = conflict?.match(/^(product_decision|doc_conflict)\s*(?:·|-|:)\s*(.+?)$/iu);
  const conflictKind = normalizeConflictKind(match?.[1]);
  const conflictTitle = match?.[2]?.trim();
  if (!conflictKind || !conflictTitle) return null;
  return { conflictKind, conflictTitle };
}

function extractDecisionScope(body: string): DecisionScope {
  const paths = collectDelimitedValues(body, ['Affected paths', 'Paths', 'Files', 'Scope paths']);
  const markers = collectDelimitedValues(body, ['Scope markers', 'Scope', 'Markers']);
  return {
    paths: normalizeList(paths),
    markers: normalizeList(markers),
  };
}

function collectDelimitedValues(body: string, names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const field = fieldFromDecisionBody(body, [name]);
    if (field) values.push(...field.split(/[,;]/u));
  }
  return values;
}

function declaredConflictChoices(body: string): string[] {
  const choices: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:\*\*)?(Option\s+[A-Za-z0-9][\w .-]*?)(?:\*\*)?\s*:/iu,
    );
    const choice = match?.[1]?.trim();
    if (choice) choices.push(choice);
  }
  return choices;
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))].sort();
}

function decisionFingerprint(input: {
  conflictKind: ProductDecisionConflictKind;
  conflictTitle: string;
  scope: DecisionScope;
}): string {
  return [
    `kind=${normalizeText(input.conflictKind)}`,
    `title=${normalizeText(input.conflictTitle)}`,
    `paths=${input.scope.paths.join(',')}`,
    `markers=${input.scope.markers.join(',')}`,
  ].join('|');
}

function normalizeConflictKind(
  value: string | undefined | null,
): ProductDecisionConflictKind | null {
  const normalized = normalizeText(value ?? '');
  return normalized === 'product_decision' || normalized === 'doc_conflict' ? normalized : null;
}

function adjudicationExternalId(body: string): string | null {
  return body.match(/^#\s+Review Adjudication:\s*(.+?)\s*$/im)?.[1]?.trim() ?? null;
}

function extractSection(body: string, heading: string): string {
  const re = new RegExp(
    `^##\\s+${escapeRegExp(heading)}\\s*$\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    'im',
  );
  const match = body.match(re);
  return match?.[1]?.trim() ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
