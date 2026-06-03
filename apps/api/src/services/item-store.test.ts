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
