import { describe, expect, it } from 'vitest';

import {
  decisionMatchesLatestAdjudication,
  parseAdjudicationBody,
  parseHumanProductDecisionComment,
  suppressSettledConflicts,
} from './adjudication.js';

describe('parseAdjudicationBody', () => {
  it('parses AUTO_REMEDIATE with unified plan', () => {
    const body = `# Review Adjudication: LEA-192

## Summary
Aligned on CSRF fix.

## Unified remediation plan
- **AUTO** · Add trusted origin guard on POST /api/sync

## Status
AUTO_REMEDIATE`;

    expect(parseAdjudicationBody(body)).toMatchObject({
      status: 'AUTO_REMEDIATE',
      unifiedPlan: '- **AUTO** · Add trusted origin guard on POST /api/sync',
    });
  });

  it('forces HUMAN_REQUIRED when product_decision conflicts remain', () => {
    const body = `# Review Adjudication: LEA-192

## Conflicts
- **product_decision** · Vacancy on empty Core search
  Code reviewer: vacate all. Haystack: add guard.

## Unified remediation plan
- **DEFERRED** · Vacancy semantics — awaiting human decision

## Status
AUTO_REMEDIATE`;

    expect(parseAdjudicationBody(body).status).toBe('HUMAN_REQUIRED');
  });

  it('parses AUTO_REMEDIATE when status line includes trailing commentary', () => {
    const body = `# Review Adjudication: LEA-192

## Status
AUTO_REMEDIATE — aligned reviewers, no open conflicts

## Unified remediation plan
- **AUTO** · Add CSRF guard`;

    expect(parseAdjudicationBody(body)).toMatchObject({
      status: 'AUTO_REMEDIATE',
    });
  });

  it('extracts unified plan sections containing the letter Z without truncating', () => {
    const body = `# Review Adjudication: LEA-192

## Unified remediation plan
- **AUTO** · Normalize timezone offsets (UTC+0) for zero-balance vouchers

## Status
AUTO_REMEDIATE`;

    expect(parseAdjudicationBody(body)).toMatchObject({
      status: 'AUTO_REMEDIATE',
      unifiedPlan: '- **AUTO** · Normalize timezone offsets (UTC+0) for zero-balance vouchers',
    });
  });

  it('defaults to HUMAN_REQUIRED when status is missing', () => {
    expect(
      parseAdjudicationBody('# Review Adjudication: X\n\n## Summary\nIncomplete'),
    ).toMatchObject({
      status: 'HUMAN_REQUIRED',
    });
  });
});

describe('product decision parsing and fingerprints', () => {
  const adjudication = `# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

## Status
HUMAN_REQUIRED`;

  it('matches short A:/B: adjudication options to Option A/B decisions', () => {
    const body = `# Review Adjudication: LEA-1

## Summary
x

## Conflicts
- **product_decision** · Fork PRs and early-loop triggering
  - A: require canonical head repo
  - B: keep branch-name-only triggering

## Status
HUMAN_REQUIRED
`;
    const decision = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Fork PRs and early-loop triggering
Chosen option: Option A`);
    expect(decision).not.toBeNull();
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'LEA-1',
        decision: decision!,
        adjudicationBodies: [body],
      }),
    ).toBe(true);
  });

  it('does not treat prose one-letter prefixes as declared options', () => {
    const body = `# Review Adjudication: LEA-1

## Conflicts
- **product_decision** · Fork PRs and early-loop triggering
  x: see the note above before deciding.
  - A: require canonical head repo

## Status
HUMAN_REQUIRED`;
    const decision = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Fork PRs and early-loop triggering
Chosen option: Option X`);

    expect(decision).not.toBeNull();
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'LEA-1',
        decision: decision!,
        adjudicationBodies: [body],
      }),
    ).toBe(false);
  });

  it('matches bulleted Option labels to Option decisions', () => {
    const body = `# Review Adjudication: LEA-1

## Conflicts
- **product_decision** · Fork PRs and early-loop triggering
  - Option A: require canonical head repo
  - Option B: keep branch-name-only triggering

## Status
HUMAN_REQUIRED`;
    const decision = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Fork PRs and early-loop triggering
Chosen option: Option A`);

    expect(decision).not.toBeNull();
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'LEA-1',
        decision: decision!,
        adjudicationBodies: [body],
      }),
    ).toBe(true);
  });

  it('normalizes structured and checklist inputs to the same fingerprint', () => {
    const structured = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: Option A`);
    const checklist = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
- [x] **product_decision** · Pick direction
- **Paths:** src/a.ts
- **Scope:** API
- **Chosen:** Option A`);

    expect(structured?.fingerprint).toBe(checklist?.fingerprint);
    expect(structured?.fingerprint).toBe(
      parseAdjudicationBody(adjudication).conflicts[0]?.fingerprint,
    );
  });

  it('accepts checklist-style decisions without the Helm HTML marker', () => {
    const checklist = parseHumanProductDecisionComment(`- [x] **product_decision** · Pick direction
- **Paths:** src/a.ts
- **Scope:** API
- **Chosen:** Option A`);

    expect(checklist).toMatchObject({
      conflictKind: 'product_decision',
      conflictTitle: 'Pick direction',
      chosenOption: 'Option A',
    });
    expect(checklist?.fingerprint).toBe(
      parseAdjudicationBody(adjudication).conflicts[0]?.fingerprint,
    );
  });

  it('rejects malformed comments without a conflict identity or choice', () => {
    expect(parseHumanProductDecisionComment('<!-- helm:product-decision -->')).toBeNull();
    expect(
      parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction`),
    ).toBeNull();
    expect(
      parseHumanProductDecisionComment('Random PR comment mentioning Option A casually'),
    ).toBeNull();
  });

  it('matches only the latest human-required adjudication for the same fingerprint and choice', () => {
    const decision = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: Option A`)!;

    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision,
        adjudicationBodies: [adjudication],
      }),
    ).toBe(true);
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision: { ...decision, chosenOption: 'Option C' },
        adjudicationBodies: [adjudication],
      }),
    ).toBe(false);
  });

  it('uses the latest adjudication when multiple adjudication comments exist', () => {
    const older = `# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

## Status
HUMAN_REQUIRED`;
    const newer = `# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.
  Option C: defer entirely.

## Status
HUMAN_REQUIRED`;
    const decisionA = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: Option A`)!;
    const decisionC = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: Option C`)!;

    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision: decisionA,
        adjudicationBodies: [older, newer],
      }),
    ).toBe(true);
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision: decisionC,
        adjudicationBodies: [older, newer],
      }),
    ).toBe(true);
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision: decisionC,
        adjudicationBodies: [older],
      }),
    ).toBe(false);
  });

  it('matches declared option labels and full option value text', () => {
    const byLabel = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: Option A`)!;
    const byValue = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: keep the current behavior`)!;

    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision: byLabel,
        adjudicationBodies: [adjudication],
      }),
    ).toBe(true);
    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision: byValue,
        adjudicationBodies: [adjudication],
      }),
    ).toBe(true);
  });

  it('rejects partial substrings of option text that are not declared choices', () => {
    const decision = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: current behavior`)!;

    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision,
        adjudicationBodies: [adjudication],
      }),
    ).toBe(false);
  });

  it('parses checklist and numbered conflict headers in adjudication bodies', () => {
    const checklistBody = `# Review Adjudication: HLM-72

## Conflicts
- [x] **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

1. **doc_conflict** - Resolve docs
  Option A: follow ADR.

## Status
HUMAN_REQUIRED`;
    const parsed = parseAdjudicationBody(checklistBody);
    expect(parsed.conflicts).toHaveLength(2);
    expect(parsed.conflicts[0]).toMatchObject({
      conflictKind: 'product_decision',
      conflictTitle: 'Pick direction',
    });
    expect(parsed.conflicts[1]).toMatchObject({
      conflictKind: 'doc_conflict',
      conflictTitle: 'Resolve docs',
    });
  });

  it('rejects choices that do not match any declared option', () => {
    const decision = parseHumanProductDecisionComment(`<!-- helm:product-decision -->
Conflict kind: product_decision
Conflict title: Pick direction
Affected paths: src/a.ts
Scope markers: API
Chosen option: Option C`)!;

    expect(
      decisionMatchesLatestAdjudication({
        externalId: 'HLM-72',
        decision,
        adjudicationBodies: [adjudication],
      }),
    ).toBe(false);
  });

  it('suppresses settled conflicts while leaving unrelated conflicts human-required', () => {
    const parsed = parseAdjudicationBody(`# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

- **product_decision** · Other direction
  Option A: one.
  Option B: two.

## Status
HUMAN_REQUIRED`);
    const settled = parsed.conflicts[0]!;

    const result = suppressSettledConflicts(parsed, [
      {
        fingerprint: settled.fingerprint,
        chosenOption: 'Option A',
      },
    ]);

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.conflictTitle).toBe('Other direction');
    expect(result.unifiedPlan).toContain('SETTLED');
    expect(result.body).toMatch(/## Status\s*\nHUMAN_REQUIRED/);
    expect(result.conflictsSection).toContain('Other direction');
    expect(result.conflictsSection).not.toContain('Pick direction');
  });

  it('flips to AUTO_REMEDIATE when every conflict is already settled', () => {
    const parsed = parseAdjudicationBody(`# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

## Unified remediation plan
- **AUTO** · Apply remaining mechanical fixes

## Status
HUMAN_REQUIRED`);
    const settled = parsed.conflicts[0]!;

    const result = suppressSettledConflicts(parsed, [
      {
        fingerprint: settled.fingerprint,
        chosenOption: 'Option A',
      },
    ]);

    expect(result.status).toBe('AUTO_REMEDIATE');
    expect(result.conflicts).toHaveLength(0);
    expect(result.body).toMatch(/## Status\s*\nAUTO_REMEDIATE/);
    expect(result.body).toContain('SETTLED');
    expect(result.body).not.toContain('**product_decision**');
  });

  it('end-to-end: unmarked checklist decision suppresses the same conflict on later adjudication', () => {
    const decision = parseHumanProductDecisionComment(`- [x] **product_decision** · Pick direction
- **Paths:** src/a.ts
- **Scope:** API
- **Chosen:** Option A`);
    expect(decision).not.toBeNull();

    const laterAdjudication = parseAdjudicationBody(`# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

## Unified remediation plan
- **AUTO** · Apply remaining mechanical fixes

## Status
HUMAN_REQUIRED`);

    const suppressed = suppressSettledConflicts(laterAdjudication, [
      {
        fingerprint: decision!.fingerprint,
        chosenOption: decision!.chosenOption,
      },
    ]);

    expect(decision!.fingerprint).toBe(laterAdjudication.conflicts[0]?.fingerprint);
    expect(suppressed.status).toBe('AUTO_REMEDIATE');
    expect(suppressed.conflicts).toHaveLength(0);
    expect(suppressed.body).toContain('SETTLED');
    expect(suppressed.body).toMatch(/## Status\s*\nAUTO_REMEDIATE/);
  });

  it('keeps fingerprints scope-sensitive so path/marker changes do not collide', () => {
    const base = parseAdjudicationBody(`# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

## Status
HUMAN_REQUIRED`);
    const differentPath = parseAdjudicationBody(`# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/b.ts
  Scope markers: API
  Option A: keep the current behavior.
  Option B: change the behavior.

## Status
HUMAN_REQUIRED`);
    const differentMarker = parseAdjudicationBody(`# Review Adjudication: HLM-72

## Conflicts
- **product_decision** · Pick direction
  Paths: src/a.ts
  Scope markers: UI
  Option A: keep the current behavior.
  Option B: change the behavior.

## Status
HUMAN_REQUIRED`);

    const baseFp = base.conflicts[0]!.fingerprint;
    const pathFp = differentPath.conflicts[0]!.fingerprint;
    const markerFp = differentMarker.conflicts[0]!.fingerprint;

    expect(baseFp).not.toBe(pathFp);
    expect(baseFp).not.toBe(markerFp);
    expect(pathFp).not.toBe(markerFp);

    const suppressedWrongScope = suppressSettledConflicts(differentPath, [
      { fingerprint: baseFp, chosenOption: 'Option A' },
    ]);
    expect(suppressedWrongScope.status).toBe('HUMAN_REQUIRED');
    expect(suppressedWrongScope.conflicts).toHaveLength(1);
  });
});
