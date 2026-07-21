import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStage } from '@helm/workflow';
import { ItemStore } from './item-store.js';
import { reconcileMergedArtifactPullRequest } from './merge-reconciliation.js';

const { mockGetItemStore, mockGetProductConfig, mockSetSubStage, mockEnsureSubStages } = vi.hoisted(
  () => ({
    mockGetItemStore: vi.fn(),
    mockGetProductConfig: vi.fn(),
    mockSetSubStage: vi.fn().mockResolvedValue(undefined),
    mockEnsureSubStages: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('./index.js', () => ({
  getItemStore: mockGetItemStore,
  getProductConfig: mockGetProductConfig,
  getIssueTrackerAdapter: vi
    .fn()
    .mockResolvedValue({ setSubStage: mockSetSubStage, ensureSubStages: mockEnsureSubStages }),
}));

let itemsDir: string;
let store: ItemStore;

beforeEach(async () => {
  itemsDir = join(tmpdir(), `helm-merge-reconcile-${randomUUID()}`);
  await mkdir(itemsDir, { recursive: true });
  store = new ItemStore(itemsDir);
  mockGetItemStore.mockResolvedValue(store);
  mockGetProductConfig.mockResolvedValue({
    product: { slug: 'test-app', name: 'Test App' },
    issue_tracker: {
      provider: 'github_projects',
      org: 'test-org',
      project_number: 1,
      custom_field_name: 'Helm Stage',
    },
    code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
    knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
    workflow: { final_stage: 'released' },
  });
  mockSetSubStage.mockClear();
  mockEnsureSubStages.mockClear();
});

afterEach(async () => {
  await rm(itemsDir, { recursive: true, force: true });
});

async function seedAt(externalId: string, stage: WorkflowStage): Promise<void> {
  await store.create({ externalId, productSlug: 'test-app', triggeredBy: 'test:create' });
  const chain: WorkflowStage[] = [
    'spec-draft',
    'spec-ready',
    'plan-draft',
    'plan-ready',
    'in-development',
    'code-review',
    'merged',
  ];
  for (const toStage of chain) {
    if ((await store.get(externalId))?.currentStage === stage) return;
    await store.transition({ externalId, toStage, triggeredBy: 'test:advance' });
  }
}

function input(headRef: string) {
  return {
    repository: { owner: 'test-org', repo: 'test-repo' },
    pullRequestId: 1234,
    pullRequestNumber: 42,
    headRef,
    merged: true,
    source: 'webhook' as const,
  };
}

describe('reconcileMergedArtifactPullRequest', () => {
  it.each([
    ['helm/spec/HLM-1', 'spec-draft', 'spec-ready'],
    ['helm/plan/HLM-1', 'plan-draft', 'plan-ready'],
    ['helm/impl/HLM-1', 'code-review', 'merged'],
  ] as const)('advances %s from current PR state', async (headRef, fromStage, toStage) => {
    await seedAt('HLM-1', fromStage);

    const result = await reconcileMergedArtifactPullRequest(input(headRef));
    const persisted = await store.get('HLM-1');

    expect(result.status).toBe('advanced');
    expect(persisted?.currentStage).toBe(toStage);
    expect(persisted?.history.at(-1)?.note).toContain(
      `merge-reconciliation:test-org/test-repo#id:1234:${toStage}`,
    );
    expect(mockSetSubStage).toHaveBeenCalledWith('HLM-1', toStage);
  });

  it('is a durable no-op when the same merged PR is reconciled twice', async () => {
    await seedAt('HLM-1', 'code-review');

    const first = await reconcileMergedArtifactPullRequest(input('helm/impl/HLM-1'));
    const historyAfterFirst = (await store.get('HLM-1'))?.history.length;
    const second = await reconcileMergedArtifactPullRequest(input('helm/impl/HLM-1'));
    const historyAfterSecond = (await store.get('HLM-1'))?.history.length;

    expect(first.status).toBe('advanced');
    expect(second.status).toBe('already-reconciled');
    expect(historyAfterSecond).toBe(historyAfterFirst);
    expect(mockSetSubStage).toHaveBeenCalledTimes(1);
  });

  it('serializes automatic and recovery overlap so only one history entry is written', async () => {
    await seedAt('HLM-1', 'code-review');

    const [auto, recovery] = await Promise.all([
      reconcileMergedArtifactPullRequest({ ...input('helm/impl/HLM-1'), source: 'webhook' }),
      reconcileMergedArtifactPullRequest({ ...input('helm/impl/HLM-1'), source: 'operator' }),
    ]);
    const persisted = await store.get('HLM-1');
    const mergeEvents =
      persisted?.history.filter((event) =>
        event.note?.includes('merge-reconciliation:test-org/test-repo#id:1234:merged'),
      ) ?? [];

    expect([auto.status, recovery.status].sort()).toEqual(['advanced', 'already-reconciled']);
    expect(mergeEvents).toHaveLength(1);
  });

  it('fails closed when a merged PR event has no stable GitHub PR id', async () => {
    await seedAt('HLM-1', 'code-review');
    const before = (await store.get('HLM-1'))?.history.length;

    const result = await reconcileMergedArtifactPullRequest({
      ...input('helm/impl/HLM-1'),
      pullRequestId: null,
      pullRequestNumber: 42,
    });

    expect(result).toMatchObject({
      status: 'ignored',
      reason: 'unstable-pr-identity',
      externalId: 'HLM-1',
    });
    expect((await store.get('HLM-1'))?.history.length).toBe(before);
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('does not write history when the item is not in the expected predecessor stage', async () => {
    await seedAt('HLM-1', 'plan-ready');
    const before = (await store.get('HLM-1'))?.history.length;

    const result = await reconcileMergedArtifactPullRequest(input('helm/impl/HLM-1'));

    expect(result).toMatchObject({
      status: 'ignored',
      reason: 'invalid-predecessor-stage',
      currentStage: 'plan-ready',
    });
    expect((await store.get('HLM-1'))?.history.length).toBe(before);
  });
});
