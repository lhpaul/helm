import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowTransitionError } from '@helm/workflow';
import { ItemAlreadyExistsError, ItemNotFoundError, StageMismatchError } from './errors.js';
import { ItemStore } from './item-store.js';

let itemsDir: string;
let store: ItemStore;

beforeEach(async () => {
  itemsDir = join(tmpdir(), `helm-items-${randomUUID()}`);
  await mkdir(itemsDir, { recursive: true });
  store = new ItemStore(itemsDir);
});

afterEach(async () => {
  await rm(itemsDir, { recursive: true, force: true });
});

const BASE_INPUT = {
  externalId: 'HLM-1',
  productSlug: 'helm',
  triggeredBy: 'human:test',
} as const;

describe('create', () => {
  it('creates item with INITIAL_STAGE (discovery)', async () => {
    const state = await store.create(BASE_INPUT);
    expect(state.currentStage).toBe('discovery');
    expect(state.externalId).toBe('HLM-1');
    expect(state.productSlug).toBe('helm');
  });

  it('initial history event has fromStage=null and toStage=discovery', async () => {
    const state = await store.create(BASE_INPUT);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.fromStage).toBeNull();
    expect(state.history[0]?.toStage).toBe('discovery');
    expect(state.history[0]?.triggeredBy).toBe('human:test');
  });

  it('throws ItemAlreadyExistsError when externalId already exists', async () => {
    await store.create(BASE_INPUT);
    await expect(store.create(BASE_INPUT)).rejects.toThrow(ItemAlreadyExistsError);
    await expect(store.create(BASE_INPUT)).rejects.toThrow('HLM-1');
  });
});

describe('get', () => {
  it('returns null when item does not exist', async () => {
    const result = await store.get('non-existent');
    expect(result).toBeNull();
  });

  it('returns the complete ItemState after create', async () => {
    await store.create(BASE_INPUT);
    const state = await store.get('HLM-1');

    expect(state).not.toBeNull();
    expect(state?.externalId).toBe('HLM-1');
    expect(state?.currentStage).toBe('discovery');
    expect(state?.history).toHaveLength(1);
  });
});

describe('transition', () => {
  it('updates currentStage on a valid transition', async () => {
    await store.create(BASE_INPUT);
    const updated = await store.transition({
      externalId: 'HLM-1',
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
    });
    expect(updated.currentStage).toBe('spec-draft');
  });

  it('appends one event to history on each transition', async () => {
    await store.create(BASE_INPUT);
    await store.transition({ externalId: 'HLM-1', toStage: 'spec-draft', triggeredBy: 't' });
    const state = await store.get('HLM-1');
    expect(state?.history).toHaveLength(2);
    expect(state?.history[1]?.fromStage).toBe('discovery');
    expect(state?.history[1]?.toStage).toBe('spec-draft');
  });

  it('updates updatedAt but preserves createdAt', async () => {
    const created = await store.create(BASE_INPUT);
    // Ensure measurable time difference
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.transition({
      externalId: 'HLM-1',
      toStage: 'spec-draft',
      triggeredBy: 't',
    });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  it('throws WorkflowTransitionError on invalid transition without modifying the file', async () => {
    await store.create(BASE_INPUT);
    await expect(
      store.transition({ externalId: 'HLM-1', toStage: 'released', triggeredBy: 't' }),
    ).rejects.toThrow(WorkflowTransitionError);

    // File must be unchanged — still at discovery
    const state = await store.get('HLM-1');
    expect(state?.currentStage).toBe('discovery');
    expect(state?.history).toHaveLength(1);
  });

  it('throws ItemNotFoundError when item does not exist', async () => {
    await expect(
      store.transition({ externalId: 'missing', toStage: 'spec-draft', triggeredBy: 't' }),
    ).rejects.toThrow(ItemNotFoundError);
  });

  it('preserves optional note in the history event', async () => {
    await store.create(BASE_INPUT);
    await store.transition({
      externalId: 'HLM-1',
      toStage: 'spec-draft',
      triggeredBy: 'human:lhpaul',
      note: 'starting spec after grooming session',
    });
    const state = await store.get('HLM-1');
    expect(state?.history[1]?.note).toBe('starting spec after grooming session');
  });
});

describe('transitionIfCurrentStage', () => {
  async function advanceToCodeReview(): Promise<void> {
    await store.create(BASE_INPUT);
    for (const toStage of [
      'spec-draft',
      'spec-ready',
      'plan-draft',
      'plan-ready',
      'in-development',
      'code-review',
    ] as const) {
      await store.transition({ externalId: 'HLM-1', toStage, triggeredBy: 'agent:test' });
    }
  }

  it('applies the transition when the predecessor stage matches', async () => {
    await advanceToCodeReview();

    const { state, applied } = await store.transitionIfCurrentStage({
      externalId: 'HLM-1',
      fromStage: 'code-review',
      toStage: 'merged',
      triggeredBy: 'webhook:code-repo',
      note: 'merge-reconciliation:example/repo#id:1:merged',
      idempotencyKey: 'merge-reconciliation:example/repo#id:1:merged',
    });

    expect(applied).toBe(true);
    expect(state.currentStage).toBe('merged');
  });

  it('is a durable no-op when the idempotency key is already in history', async () => {
    await advanceToCodeReview();
    const key = 'merge-reconciliation:example/repo#id:1:merged';
    await store.transitionIfCurrentStage({
      externalId: 'HLM-1',
      fromStage: 'code-review',
      toStage: 'merged',
      triggeredBy: 'webhook:code-repo',
      note: key,
      idempotencyKey: key,
    });
    const historyAfterFirst = (await store.get('HLM-1'))?.history.length;

    const { state, applied } = await store.transitionIfCurrentStage({
      externalId: 'HLM-1',
      fromStage: 'code-review',
      toStage: 'merged',
      triggeredBy: 'operator:recovery',
      note: key,
      idempotencyKey: key,
    });

    expect(applied).toBe(false);
    expect(state.currentStage).toBe('merged');
    expect(state.history).toHaveLength(historyAfterFirst ?? 0);
    expect(state.history.at(-1)?.idempotencyKey).toBe(key);
  });

  it('throws StageMismatchError when the predecessor stage does not match', async () => {
    await advanceToCodeReview();

    await expect(
      store.transitionIfCurrentStage({
        externalId: 'HLM-1',
        fromStage: 'plan-ready',
        toStage: 'merged',
        triggeredBy: 'webhook:code-repo',
      }),
    ).rejects.toThrow(StageMismatchError);
  });

  it('ignores crafted transition notes that only contain the key as a substring', async () => {
    await store.create(BASE_INPUT);
    await store.transition({
      externalId: 'HLM-1',
      toStage: 'spec-draft',
      triggeredBy: 'human:spoof',
      note: 'merge-reconciliation:example/repo#id:9:spec-ready; forged',
    });

    const { state, applied } = await store.transitionIfCurrentStage({
      externalId: 'HLM-1',
      fromStage: 'spec-draft',
      toStage: 'spec-ready',
      triggeredBy: 'webhook:knowledge-repo',
      note: 'merge-reconciliation:example/repo#id:9:spec-ready; source:webhook',
      idempotencyKey: 'merge-reconciliation:example/repo#id:9:spec-ready',
    });

    expect(applied).toBe(true);
    expect(state.currentStage).toBe('spec-ready');
    expect(state.history.at(-1)?.idempotencyKey).toBe(
      'merge-reconciliation:example/repo#id:9:spec-ready',
    );
  });
});

describe('forceTransition', () => {
  // Advances an item along the valid forward chain to 'in-development', the
  // only stage from which a rollback to 'plan-ready' is permitted (ADR-029).
  async function advanceToInDevelopment(): Promise<void> {
    await store.create(BASE_INPUT);
    for (const toStage of [
      'spec-draft',
      'spec-ready',
      'plan-draft',
      'plan-ready',
      'in-development',
    ] as const) {
      await store.transition({ externalId: 'HLM-1', toStage, triggeredBy: 'agent:test' });
    }
  }

  it('applies the in-development → plan-ready edge that transition() rejects', async () => {
    await advanceToInDevelopment();
    const updated = await store.forceTransition({
      externalId: 'HLM-1',
      fromStage: 'in-development',
      toStage: 'plan-ready',
      triggeredBy: 'manual:rollback',
      note: 'codex image-tool crash, $0 cost',
    });
    expect(updated.currentStage).toBe('plan-ready');
    const last = updated.history[updated.history.length - 1];
    expect(last?.fromStage).toBe('in-development');
    expect(last?.toStage).toBe('plan-ready');
    expect(last?.triggeredBy).toBe('manual:rollback');
    expect(last?.note).toBe('codex image-tool crash, $0 cost');
  });

  it('regression: transition() still rejects the same edge (bypass is not accidental)', async () => {
    await advanceToInDevelopment();
    await expect(
      store.transition({ externalId: 'HLM-1', toStage: 'plan-ready', triggeredBy: 't' }),
    ).rejects.toThrow(WorkflowTransitionError);
  });

  it('throws StageMismatchError when current stage does not match fromStage, leaving the file unchanged', async () => {
    await store.create(BASE_INPUT); // still at 'discovery'
    await expect(
      store.forceTransition({
        externalId: 'HLM-1',
        fromStage: 'in-development',
        toStage: 'plan-ready',
        triggeredBy: 'manual:rollback',
        note: 'reason',
      }),
    ).rejects.toThrow(StageMismatchError);

    const state = await store.get('HLM-1');
    expect(state?.currentStage).toBe('discovery');
    expect(state?.history).toHaveLength(1);
  });

  it('throws ItemNotFoundError when item does not exist', async () => {
    await expect(
      store.forceTransition({
        externalId: 'missing',
        fromStage: 'in-development',
        toStage: 'plan-ready',
        triggeredBy: 'manual:rollback',
        note: 'reason',
      }),
    ).rejects.toThrow(ItemNotFoundError);
  });
});

describe('upsertResolvedProductDecision', () => {
  const decision = {
    fingerprint: 'kind=product_decision|title=pick direction|paths=src/a.ts|markers=api',
    conflictKind: 'product_decision' as const,
    conflictTitle: 'Pick direction',
    scope: { paths: ['src/a.ts'], markers: ['api'] },
    chosenOption: 'Option A',
    recordedAt: '2026-07-22T12:00:00.000Z',
    source: {
      provider: 'github' as const,
      owner: 'test-org',
      repo: 'test-repo',
      prNumber: 42,
      authorLogin: 'maintainer',
    },
  };

  it('persists a resolved decision with audit history', async () => {
    await store.create(BASE_INPUT);

    const { state, inserted } = await store.upsertResolvedProductDecision({
      externalId: 'HLM-1',
      decision,
      triggeredBy: 'webhook:pr-decision-comment',
    });

    expect(inserted).toBe(true);
    expect(state.resolvedProductDecisions).toEqual([decision]);
    expect(state.history.at(-1)).toMatchObject({
      fromStage: 'discovery',
      toStage: 'discovery',
      triggeredBy: 'webhook:pr-decision-comment',
      idempotencyKey: `resolved-product-decision:${decision.fingerprint}`,
    });
    expect(state.history.at(-1)?.note).toContain('resolved_product_decision');
  });

  it('does not duplicate the same decision fingerprint', async () => {
    await store.create(BASE_INPUT);
    await store.upsertResolvedProductDecision({
      externalId: 'HLM-1',
      decision,
      triggeredBy: 'webhook:pr-decision-comment',
    });

    const replay = await store.upsertResolvedProductDecision({
      externalId: 'HLM-1',
      decision: { ...decision, chosenOption: 'Option A again' },
      triggeredBy: 'webhook:pr-decision-comment',
    });

    expect(replay.inserted).toBe(false);
    expect(replay.state.resolvedProductDecisions).toHaveLength(1);
    expect(
      replay.state.history.filter((event) => event.note?.includes(decision.fingerprint)),
    ).toHaveLength(1);
  });

  it('reloads the decision ledger from disk after a restart-style re-read', async () => {
    await store.create(BASE_INPUT);
    await store.upsertResolvedProductDecision({
      externalId: 'HLM-1',
      decision,
      triggeredBy: 'webhook:pr-decision-comment',
    });

    const restartedStore = new ItemStore(itemsDir);
    const state = await restartedStore.get('HLM-1');

    expect(state?.resolvedProductDecisions?.[0]).toEqual(decision);
  });

  it('preserves decisions across concurrent transition and upsert writers', async () => {
    await store.create(BASE_INPUT);
    await store.transition({
      externalId: 'HLM-1',
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
    });

    const [transitioned, upserted] = await Promise.all([
      store.transition({
        externalId: 'HLM-1',
        toStage: 'spec-ready',
        triggeredBy: 'agent:spec-reviewer',
      }),
      store.upsertResolvedProductDecision({
        externalId: 'HLM-1',
        decision,
        triggeredBy: 'webhook:pr-decision-comment',
      }),
    ]);

    const finalState = await store.get('HLM-1');
    expect(finalState?.currentStage).toBe('spec-ready');
    expect(finalState?.resolvedProductDecisions).toEqual([decision]);
    // Serialized writers: final disk state is the source of truth.
    expect(transitioned.currentStage).toBe('spec-ready');
    expect(upserted.state.resolvedProductDecisions).toEqual([decision]);
  });

  it('serializes concurrent upserts so distinct decision fingerprints both persist', async () => {
    await store.create(BASE_INPUT);
    const otherDecision = {
      ...decision,
      fingerprint: 'kind=product_decision|title=other direction|paths=src/b.ts|markers=api',
      conflictTitle: 'Other direction',
      scope: { paths: ['src/b.ts'], markers: ['api'] },
      chosenOption: 'Option B',
    };

    const [first, second] = await Promise.all([
      store.upsertResolvedProductDecision({
        externalId: 'HLM-1',
        decision,
        triggeredBy: 'webhook:pr-decision-comment',
      }),
      store.upsertResolvedProductDecision({
        externalId: 'HLM-1',
        decision: otherDecision,
        triggeredBy: 'webhook:pr-decision-comment',
      }),
    ]);

    const finalState = await store.get('HLM-1');
    expect(finalState?.resolvedProductDecisions).toHaveLength(2);
    expect(finalState?.resolvedProductDecisions?.map((d) => d.fingerprint).sort()).toEqual(
      [decision.fingerprint, otherDecision.fingerprint].sort(),
    );
    expect(first.inserted && second.inserted).toBe(true);
  });

  it('survives a stage move then re-dispatch-style reload of the decision ledger', async () => {
    await store.create(BASE_INPUT);
    await store.upsertResolvedProductDecision({
      externalId: 'HLM-1',
      decision,
      triggeredBy: 'webhook:pr-decision-comment',
    });
    await store.transition({
      externalId: 'HLM-1',
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
    });

    // Simulate dispatch-scheduler refreshing item state from disk at job start.
    const dispatchRead = await new ItemStore(itemsDir).get('HLM-1');
    expect(dispatchRead?.currentStage).toBe('spec-draft');
    expect(dispatchRead?.resolvedProductDecisions).toEqual([decision]);
  });
});

describe('list', () => {
  it('returns empty array when items directory is empty', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('returns all created items (order not guaranteed)', async () => {
    await store.create({ externalId: 'HLM-1', productSlug: 'helm', triggeredBy: 't' });
    await store.create({ externalId: 'HLM-2', productSlug: 'helm', triggeredBy: 't' });
    await store.create({ externalId: 'HLM-3', productSlug: 'helm', triggeredBy: 't' });

    const items = await store.list();
    const ids = items.map((i) => i.externalId).sort();
    expect(ids).toEqual(['HLM-1', 'HLM-2', 'HLM-3']);
  });

  it('ignores non-JSON files and dotfiles in items directory', async () => {
    await store.create(BASE_INPUT);
    // Simulate filesystem noise
    await writeFile(join(itemsDir, '.DS_Store'), 'binary noise');
    await writeFile(join(itemsDir, '.gitkeep'), '');
    await writeFile(join(itemsDir, 'README.txt'), 'not an item');

    const items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe('HLM-1');
  });
});

describe('externalId validation', () => {
  it('rejects path traversal sequences in all public methods', async () => {
    const traversalId = '../escape';
    await expect(
      store.create({ externalId: traversalId, productSlug: 'helm', triggeredBy: 't' }),
    ).rejects.toThrow('Invalid externalId');
    await expect(store.get(traversalId)).rejects.toThrow('Invalid externalId');
    await expect(
      store.transition({ externalId: traversalId, toStage: 'spec-draft', triggeredBy: 't' }),
    ).rejects.toThrow('Invalid externalId');
  });

  it('rejects leading-dot IDs that would be invisible to list()', async () => {
    // list() filters dotfiles with !f.startsWith('.'), so .foo.json would be
    // written by create() but never returned — guard against the inconsistency.
    await expect(
      store.create({ externalId: '.hidden', productSlug: 'helm', triggeredBy: 't' }),
    ).rejects.toThrow('Invalid externalId');
  });

  it('accepts standard tracker ID formats', async () => {
    for (const id of ['MOM-142', 'HLM-7', 'issue_3', 'feature.v2', 'PROJ-001']) {
      await expect(
        store.create({ externalId: id, productSlug: 'helm', triggeredBy: 't' }),
      ).resolves.toBeDefined();
    }
  });
});

describe('updateReviewLoopLedger', () => {
  it('creates the lane entry on the first recorded cycle', async () => {
    await store.create(BASE_INPUT);

    const state = await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: { cyclesTotal: 1, noProgressStreak: 0, bestBlockerCount: 3 },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    expect(state.reviewLoopLedger?.['code-review']).toMatchObject({
      cyclesTotal: 1,
      noProgressStreak: 0,
      bestBlockerCount: 3,
    });
    // Ordinary ticks stay out of history — only escalations are audit-worthy.
    expect(state.history).toHaveLength(1);
  });

  it('survives a restart-style re-read', async () => {
    await store.create(BASE_INPUT);
    await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: { cyclesTotal: 6, noProgressStreak: 1 },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    const restartedStore = new ItemStore(itemsDir);
    const state = await restartedStore.get('HLM-1');

    expect(state?.reviewLoopLedger?.['code-review']?.cyclesTotal).toBe(6);
  });

  it('never hands cumulative budget back to a stale writer', async () => {
    await store.create(BASE_INPUT);
    await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: { cyclesTotal: 9, noProgressStreak: 2, bestBlockerCount: 1 },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    const state = await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: { cyclesTotal: 2, noProgressStreak: 0, bestBlockerCount: 4 },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    expect(state.reviewLoopLedger?.['code-review']?.cyclesTotal).toBe(9);
    expect(state.reviewLoopLedger?.['code-review']?.bestBlockerCount).toBe(1);
    // Streak is last-writer-wins: real progress has to be able to reset it.
    expect(state.reviewLoopLedger?.['code-review']?.noProgressStreak).toBe(0);
  });

  it('records an escalation in the item history', async () => {
    await store.create(BASE_INPUT);

    const state = await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: {
        cyclesTotal: 15,
        noProgressStreak: 2,
        escalatedAt: '2026-08-13T12:00:00.000Z',
        escalationReason: 'max_cycles_cumulative',
      },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    expect(state.reviewLoopLedger?.['code-review']).toMatchObject({
      escalatedAt: '2026-08-13T12:00:00.000Z',
      escalationReason: 'max_cycles_cumulative',
    });
    expect(state.history.at(-1)).toMatchObject({
      fromStage: 'discovery',
      toStage: 'discovery',
      triggeredBy: 'review-loop:cumulative-budget',
    });
    expect(state.history.at(-1)?.note).toContain('max_cycles_cumulative');
  });

  it('does not duplicate the escalation event when the same budget state re-escalates', async () => {
    await store.create(BASE_INPUT);
    const escalation = {
      cyclesTotal: 15,
      noProgressStreak: 2,
      escalatedAt: '2026-08-13T12:00:00.000Z',
      escalationReason: 'max_cycles_cumulative' as const,
    };
    await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: escalation,
      triggeredBy: 'review-loop:cumulative-budget',
    });

    // A still-blocked item re-escalates on every re-dispatch.
    const replay = await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: { ...escalation, escalatedAt: '2026-08-13T13:00:00.000Z' },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    expect(
      replay.history.filter((event) => event.note?.includes('review_loop_escalated')),
    ).toHaveLength(1);
    // The ledger still tracks the latest escalation timestamp.
    expect(replay.reviewLoopLedger?.['code-review']?.escalatedAt).toBe('2026-08-13T13:00:00.000Z');
  });

  it('records a second escalation once more cycles have been consumed', async () => {
    await store.create(BASE_INPUT);
    for (const cyclesTotal of [15, 18]) {
      await store.updateReviewLoopLedger({
        externalId: 'HLM-1',
        lane: 'code-review',
        update: {
          cyclesTotal,
          noProgressStreak: 2,
          escalatedAt: '2026-08-13T12:00:00.000Z',
          escalationReason: 'max_cycles_cumulative',
        },
        triggeredBy: 'review-loop:cumulative-budget',
      });
    }

    const state = await store.get('HLM-1');
    expect(
      state?.history.filter((event) => event.note?.includes('review_loop_escalated')),
    ).toHaveLength(2);
  });

  it('keeps lanes independent so a draft loop cannot spend the code-review budget', async () => {
    await store.create(BASE_INPUT);
    await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'spec-draft',
      update: { cyclesTotal: 4, noProgressStreak: 0 },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    const state = await store.updateReviewLoopLedger({
      externalId: 'HLM-1',
      lane: 'code-review',
      update: { cyclesTotal: 1, noProgressStreak: 0 },
      triggeredBy: 'review-loop:cumulative-budget',
    });

    expect(state.reviewLoopLedger?.['spec-draft']?.cyclesTotal).toBe(4);
    expect(state.reviewLoopLedger?.['code-review']?.cyclesTotal).toBe(1);
  });

  it('preserves the ledger across a concurrent transition', async () => {
    await store.create(BASE_INPUT);

    await Promise.all([
      store.transition({
        externalId: 'HLM-1',
        toStage: 'spec-draft',
        triggeredBy: 'agent:spec-writer',
      }),
      store.updateReviewLoopLedger({
        externalId: 'HLM-1',
        lane: 'spec-draft',
        update: { cyclesTotal: 1, noProgressStreak: 0 },
        triggeredBy: 'review-loop:cumulative-budget',
      }),
    ]);

    const finalState = await store.get('HLM-1');
    expect(finalState?.currentStage).toBe('spec-draft');
    expect(finalState?.reviewLoopLedger?.['spec-draft']?.cyclesTotal).toBe(1);
  });

  it('throws ItemNotFoundError for an unknown item', async () => {
    await expect(
      store.updateReviewLoopLedger({
        externalId: 'HLM-404',
        lane: 'code-review',
        update: { cyclesTotal: 1, noProgressStreak: 0 },
        triggeredBy: 'review-loop:cumulative-budget',
      }),
    ).rejects.toThrow(ItemNotFoundError);
  });
});
