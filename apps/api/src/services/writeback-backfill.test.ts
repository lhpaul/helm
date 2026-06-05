import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { IssueTrackerAdapter } from '@helm/adapters';
import type { WorkflowStage } from '@helm/workflow';
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

const item = (externalId: string, currentStage: WorkflowStage): ItemState => ({
  externalId,
  productSlug: 'p',
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

describe('backfillProductStages', () => {
  it('runs ensureSubStages once, then setSubStage for every store item', async () => {
    const items = [item('LEA-1', 'merged'), item('LEA-2', 'released'), item('LEA-3', 'discovery')];

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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
