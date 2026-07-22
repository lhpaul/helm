/**
 * Cross-layer regression: webhook-shaped decision → ItemStore ledger →
 * dispatch-style reload → adjudicator suppression on the next cycle.
 */
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseAdjudicationBody,
  parseHumanProductDecisionComment,
  suppressSettledConflicts,
} from '@helm/orchestrator';
import { ItemStore } from './item-store.js';

let itemsDir: string;
let store: ItemStore;

beforeEach(async () => {
  itemsDir = join(tmpdir(), `helm-settled-redispatch-${randomUUID()}`);
  await mkdir(itemsDir, { recursive: true });
  store = new ItemStore(itemsDir);
});

afterEach(async () => {
  await rm(itemsDir, { recursive: true, force: true });
});

describe('settled decision redispatch (cross-layer)', () => {
  it('records a checklist decision, reloads it, and suppresses the conflict on re-adjudication', async () => {
    await store.create({
      externalId: 'issue_72',
      productSlug: 'helm',
      triggeredBy: 'human:test',
    });
    await store.transition({
      externalId: 'issue_72',
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
    });
    // Advance toward code-review is unnecessary for the ledger bridge; the
    // important seam is persistence → reload → suppress.

    const decision = parseHumanProductDecisionComment(`- [x] **product_decision** · Pick direction
- **Paths:** src/a.ts
- **Scope:** API
- **Chosen:** keep the current behavior`);
    expect(decision).not.toBeNull();

    await store.upsertResolvedProductDecision({
      externalId: 'issue_72',
      decision: {
        fingerprint: decision!.fingerprint,
        conflictKind: decision!.conflictKind,
        conflictTitle: decision!.conflictTitle,
        scope: decision!.scope,
        chosenOption: decision!.chosenOption,
        source: {
          provider: 'github',
          owner: 'lhpaul',
          repo: 'helm',
          prNumber: 77,
          authorLogin: 'maintainer',
        },
      },
      triggeredBy: 'webhook:pr-decision-comment',
    });

    // dispatch-scheduler loadResolvedProductDecisions shape: fresh get + copy.
    const latest = await new ItemStore(itemsDir).get('issue_72');
    expect(latest).not.toBeNull();
    const reloaded = [...(latest!.resolvedProductDecisions ?? [])];
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.chosenOption).toBe('keep the current behavior');

    const laterAdjudication = parseAdjudicationBody(`# Review Adjudication: issue_72

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

    const suppressed = suppressSettledConflicts(laterAdjudication, reloaded);

    expect(suppressed.status).toBe('AUTO_REMEDIATE');
    expect(suppressed.conflicts).toHaveLength(0);
    expect(suppressed.body).toContain('SETTLED');
    expect(suppressed.body).toMatch(/## Status\s*\nAUTO_REMEDIATE/);
    expect(suppressed.body).not.toMatch(/## Conflicts[\s\S]*product_decision/);
  });
});
