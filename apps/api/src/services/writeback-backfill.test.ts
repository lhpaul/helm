import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { IssueTrackerAdapter } from '@helm/adapters';
import type { WorkflowStage } from '@helm/workflow';
import { TRACKER_WRITE_TIMEOUT_MS } from '../lib/with-timeout.js';
import { backfillProductStages } from './writeback-backfill.js';
import type { ItemState } from './types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// The service is provider-agnostic when an adapter is injected; the cast keeps
// the fixtures minimal (only product.slug + issue_tracker are read).

const ghProduct = {
  product: { slug: 'gh-app', name: 'GH App' },
  issue_tracker: {
    provider: 'github_projects',
    org: 'test-org',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
} as unknown as Product;

const linearProduct = {
  product: { slug: 'af', name: 'AF' },
  issue_tracker: {
    provider: 'linear',
    team_key: 'LEA',
    api_key_env: 'LINEAR_API_KEY',
    webhook_secret_env: 'LINEAR_WEBHOOK_SECRET',
  },
} as unknown as Product;

// productSlug defaults to the github fixture's slug; the Linear test overrides it.
// Backfill scopes to items whose productSlug matches the product under test, so
// fixtures must carry the right slug.
const item = (
  externalId: string,
  currentStage: WorkflowStage,
  productSlug = 'gh-app',
): ItemState => ({
  externalId,
  productSlug,
  currentStage,
  history: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

let adapter: {
  ensureSubStages: ReturnType<typeof vi.fn>;
  setSubStage: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  adapter = {
    ensureSubStages: vi.fn().mockResolvedValue(undefined),
    setSubStage: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  // Reset timers + spies here (not in the test body) so a mid-test assertion
  // failure cannot leak fake timers or spies into the next test.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('backfillProductStages', () => {
  it('runs ensureSubStages once, then setSubStage for every store item', async () => {
    const items = [
      item('LEA-1', 'merged', 'af'),
      item('LEA-2', 'released', 'af'),
      item('LEA-3', 'discovery', 'af'),
    ];

    const result = await backfillProductStages(linearProduct, 'linear-key', '/data', {
      _adapter: adapter as unknown as IssueTrackerAdapter,
      _listItems: async () => items,
    });

    expect(adapter.ensureSubStages).toHaveBeenCalledTimes(1);
    expect(adapter.ensureSubStages).toHaveBeenCalledWith(linearProduct.issue_tracker);
    expect(adapter.setSubStage).toHaveBeenCalledTimes(3);
    expect(adapter.setSubStage).toHaveBeenCalledWith('LEA-1', 'merged');
    expect(adapter.setSubStage).toHaveBeenCalledWith('LEA-2', 'released');
    expect(adapter.setSubStage).toHaveBeenCalledWith('LEA-3', 'discovery');
    expect(result).toMatchObject({ reconciled: 3, total: 3, failed: 0 });
  });

  it('continues past a per-item failure (best-effort), counting reconciled vs failed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.setSubStage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('item not in tracker'))
      .mockResolvedValueOnce(undefined);
    const items = [item('A', 'merged'), item('B', 'merged'), item('C', 'merged')];

    const result = await backfillProductStages(ghProduct, 'gh-token', '/data', {
      _adapter: adapter as unknown as IssueTrackerAdapter,
      _listItems: async () => items,
    });

    // All three were attempted — the failure did not abort the loop.
    expect(adapter.setSubStage).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ reconciled: 2, total: 3, failed: 1 });
    expect(errSpy).toHaveBeenCalled();
  });

  it('reconciles only items belonging to the target product (shared store)', async () => {
    // The store is shared across products; backfill for gh-app must ignore af's items.
    const items = [
      item('GH-1', 'merged', 'gh-app'),
      item('LEA-9', 'released', 'af'),
      item('GH-2', 'spec-ready', 'gh-app'),
    ];

    const result = await backfillProductStages(ghProduct, 'gh-token', '/data', {
      _adapter: adapter as unknown as IssueTrackerAdapter,
      _listItems: async () => items,
    });

    expect(adapter.setSubStage).toHaveBeenCalledTimes(2);
    expect(adapter.setSubStage).toHaveBeenCalledWith('GH-1', 'merged');
    expect(adapter.setSubStage).toHaveBeenCalledWith('GH-2', 'spec-ready');
    expect(adapter.setSubStage).not.toHaveBeenCalledWith('LEA-9', 'released');
    // total reflects the product-scoped count, not the full store.
    expect(result).toMatchObject({ reconciled: 2, total: 2, failed: 0 });
  });

  it('is provider-agnostic — reconciles a github_projects product the same way', async () => {
    const result = await backfillProductStages(ghProduct, 'gh-token', '/data', {
      _adapter: adapter as unknown as IssueTrackerAdapter,
      _listItems: async () => [item('issue_1', 'spec-ready')],
    });

    expect(adapter.ensureSubStages).toHaveBeenCalledWith(ghProduct.issue_tracker);
    expect(adapter.setSubStage).toHaveBeenCalledWith('issue_1', 'spec-ready');
    expect(result.reconciled).toBe(1);
  });

  it('handles an empty store: ensures the map but writes nothing', async () => {
    const result = await backfillProductStages(ghProduct, 'gh-token', '/data', {
      _adapter: adapter as unknown as IssueTrackerAdapter,
      _listItems: async () => [],
    });

    expect(adapter.ensureSubStages).toHaveBeenCalledTimes(1);
    expect(adapter.setSubStage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reconciled: 0, total: 0, failed: 0 });
  });

  it('times out a stalled item, counts it failed, and continues the batch', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Item B's setSubStage never resolves; A and C settle immediately.
    adapter.setSubStage.mockImplementation((externalId: string) =>
      externalId === 'B' ? new Promise(() => {}) : Promise.resolve(),
    );
    const items = [item('A', 'merged'), item('B', 'merged'), item('C', 'merged')];

    const pending = backfillProductStages(ghProduct, 'gh-token', '/data', {
      _adapter: adapter as unknown as IssueTrackerAdapter,
      _listItems: async () => items,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_WRITE_TIMEOUT_MS);
    const result = await pending;

    expect(adapter.setSubStage).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ reconciled: 2, total: 3, failed: 1 });
    expect(errSpy).toHaveBeenCalled();
    // Timer/spy cleanup happens in afterEach (failure-safe).
  });

  it('aborts (propagates) if ensureSubStages fails — no item could be reconciled', async () => {
    adapter.ensureSubStages.mockRejectedValue(new Error('cannot create field'));

    await expect(
      backfillProductStages(ghProduct, 'gh-token', '/data', {
        _adapter: adapter as unknown as IssueTrackerAdapter,
        _listItems: async () => [item('issue_1', 'merged')],
      }),
    ).rejects.toThrow('cannot create field');
    expect(adapter.setSubStage).not.toHaveBeenCalled();
  });

  // ── Native workflow state (ADR-034) ───────────────────────────────────────────

  describe('native workflow state', () => {
    let linearAdapter: {
      ensureSubStages: ReturnType<typeof vi.fn>;
      setSubStage: ReturnType<typeof vi.fn>;
      setWorkflowStateByType: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      linearAdapter = {
        ensureSubStages: vi.fn().mockResolvedValue(undefined),
        setSubStage: vi.fn().mockResolvedValue(undefined),
        setWorkflowStateByType: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('sets the mapped native state per item for a Linear product', async () => {
      const items = [item('LEA-1', 'merged', 'af'), item('LEA-2', 'discovery', 'af')];

      const result = await backfillProductStages(linearProduct, 'linear-key', '/data', {
        _adapter: linearAdapter as unknown as IssueTrackerAdapter,
        _listItems: async () => items,
      });

      expect(linearAdapter.setWorkflowStateByType).toHaveBeenCalledWith('LEA-1', 'completed');
      expect(linearAdapter.setWorkflowStateByType).toHaveBeenCalledWith('LEA-2', 'started');
      expect(result).toMatchObject({ reconciled: 2, nativeReconciled: 2, nativeFailed: 0 });
    });

    it('continues past a per-item native failure without aborting or flipping `failed`', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      linearAdapter.setWorkflowStateByType
        .mockRejectedValueOnce(new Error('no completed state'))
        .mockResolvedValue(undefined);
      const items = [item('LEA-1', 'merged', 'af'), item('LEA-2', 'merged', 'af')];

      const result = await backfillProductStages(linearProduct, 'linear-key', '/data', {
        _adapter: linearAdapter as unknown as IssueTrackerAdapter,
        _listItems: async () => items,
      });

      // The label write (primary signal) succeeded for both; the native failure
      // is secondary and must NOT flip the item to `failed`.
      expect(linearAdapter.setSubStage).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        reconciled: 2,
        failed: 0,
        nativeReconciled: 1,
        nativeFailed: 1,
      });
      expect(errSpy).toHaveBeenCalled();
    });

    it('skips the native-state step for a GitHub product even when the adapter supports it', async () => {
      const ghAdapter = {
        ensureSubStages: vi.fn().mockResolvedValue(undefined),
        setSubStage: vi.fn().mockResolvedValue(undefined),
        setWorkflowStateByType: vi.fn().mockResolvedValue(undefined),
      };

      const result = await backfillProductStages(ghProduct, 'gh-token', '/data', {
        _adapter: ghAdapter as unknown as IssueTrackerAdapter,
        _listItems: async () => [item('GH-1', 'merged')],
      });

      expect(ghAdapter.setSubStage).toHaveBeenCalledWith('GH-1', 'merged');
      expect(ghAdapter.setWorkflowStateByType).not.toHaveBeenCalled();
      expect(result).toMatchObject({ reconciled: 1, nativeReconciled: 0, nativeFailed: 0 });
    });
  });

  it('rejects an unsupported provider when building the default adapter', async () => {
    const badProduct = {
      product: { slug: 'x', name: 'X' },
      issue_tracker: { provider: 'jira' },
    } as unknown as Product;

    await expect(
      backfillProductStages(badProduct, 'cred', '/data', { _listItems: async () => [] }),
    ).rejects.toThrow(/unsupported issue_tracker\.provider 'jira'/);
  });
});
