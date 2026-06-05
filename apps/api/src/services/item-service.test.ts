import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStage } from '@helm/workflow';
import { TRACKER_WRITE_TIMEOUT_MS } from '../lib/with-timeout.js';
import type { ItemState } from './types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// item-service.ts pulls its three factory accessors from ./index.js. We replace
// just those so the wrapper logic (anti-echo, memoized ensure, best-effort) runs
// against controllable stubs — no filesystem, no network.

const { mockGetItemStore, mockGetProductConfig, mockGetAdapter } = vi.hoisted(() => ({
  mockGetItemStore: vi.fn(),
  mockGetProductConfig: vi.fn(),
  mockGetAdapter: vi.fn(),
}));

vi.mock('./index.js', () => ({
  getItemStore: mockGetItemStore,
  getProductConfig: mockGetProductConfig,
  getIssueTrackerAdapter: mockGetAdapter,
}));

import { createItem, forceTransitionItem, transitionItem } from './item-service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUE_TRACKER = {
  provider: 'github_projects' as const,
  org: 'test-org',
  project_number: 1,
  custom_field_name: 'Helm Stage',
};

const itemAt = (currentStage: WorkflowStage, externalId = 'HLM-1'): ItemState => ({
  externalId,
  productSlug: 'test-product',
  currentStage,
  history: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

let store: {
  transition: ReturnType<typeof vi.fn>;
  forceTransition: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};
let adapter: {
  setSubStage: ReturnType<typeof vi.fn>;
  ensureSubStages: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  store = { transition: vi.fn(), forceTransition: vi.fn(), create: vi.fn() };
  // A FRESH adapter per test so the module-level ensureSubStages WeakMap memo
  // (keyed on the adapter instance) does not leak across tests.
  adapter = {
    setSubStage: vi.fn().mockResolvedValue(undefined),
    ensureSubStages: vi.fn().mockResolvedValue(undefined),
  };
  mockGetItemStore.mockResolvedValue(store);
  mockGetProductConfig.mockResolvedValue({ issue_tracker: ISSUE_TRACKER });
  mockGetAdapter.mockResolvedValue(adapter);
});

afterEach(() => {
  // Reset timers + spies here (not in the test body) so a mid-test assertion
  // failure cannot leak fake timers or spies into the next test.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── transitionItem: writeback on a normal transition ──────────────────────────

describe('transitionItem', () => {
  it('writes the resulting stage back to the tracker on a normal transition', async () => {
    store.transition.mockResolvedValue(itemAt('spec-ready'));

    const result = await transitionItem({
      externalId: 'HLM-1',
      toStage: 'spec-ready',
      triggeredBy: 'agent:spec-writer',
    });

    expect(result.currentStage).toBe('spec-ready');
    expect(store.transition).toHaveBeenCalledTimes(1);
    expect(adapter.ensureSubStages).toHaveBeenCalledTimes(1);
    expect(adapter.ensureSubStages).toHaveBeenCalledWith(ISSUE_TRACKER);
    expect(adapter.setSubStage).toHaveBeenCalledWith('HLM-1', 'spec-ready');
  });

  // ── Anti-echo ───────────────────────────────────────────────────────────────

  it.each(['webhook:github-projects', 'webhook:linear'])(
    'does NOT write back for tracker-originated trigger %s (anti-echo)',
    async (triggeredBy) => {
      store.transition.mockResolvedValue(itemAt('spec-ready'));

      const result = await transitionItem({
        externalId: 'HLM-1',
        toStage: 'spec-ready',
        triggeredBy,
      });

      expect(result.currentStage).toBe('spec-ready');
      // Short-circuits before resolving the adapter at all.
      expect(mockGetAdapter).not.toHaveBeenCalled();
      expect(adapter.setSubStage).not.toHaveBeenCalled();
    },
  );

  it.each([
    'webhook:release',
    'webhook:code-repo',
    'webhook:knowledge-repo',
    'manual:release',
    'agent:implementer',
  ])('writes back for non-tracker trigger %s', async (triggeredBy) => {
    store.transition.mockResolvedValue(itemAt('released'));

    await transitionItem({ externalId: 'HLM-1', toStage: 'released', triggeredBy });

    expect(adapter.setSubStage).toHaveBeenCalledWith('HLM-1', 'released');
  });

  // ── Best-effort ───────────────────────────────────────────────────────────────

  it('is best-effort: a setSubStage failure still returns the store result and logs an error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.setSubStage.mockRejectedValue(new Error('tracker 503'));
    store.transition.mockResolvedValue(itemAt('spec-ready'));

    const result = await transitionItem({
      externalId: 'HLM-1',
      toStage: 'spec-ready',
      triggeredBy: 'agent:spec-writer',
    });

    expect(result.currentStage).toBe('spec-ready');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[writeback] failed for HLM-1→spec-ready'),
      expect.anything(),
    );
  });

  it('is best-effort: an adapter resolution failure (e.g. missing token) does not fail the transition', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetAdapter.mockRejectedValue(new Error('GITHUB_TOKEN is not set'));
    store.transition.mockResolvedValue(itemAt('spec-ready'));

    const result = await transitionItem({
      externalId: 'HLM-1',
      toStage: 'spec-ready',
      triggeredBy: 'agent:spec-writer',
    });

    expect(result.currentStage).toBe('spec-ready');
    expect(adapter.setSubStage).not.toHaveBeenCalled();
  });

  it('is best-effort: a hung setSubStage times out without failing the transition', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // setSubStage never resolves — without a timeout this would hang the request.
    adapter.setSubStage.mockReturnValue(new Promise(() => {}));
    store.transition.mockResolvedValue(itemAt('spec-ready'));

    const pending = transitionItem({
      externalId: 'HLM-1',
      toStage: 'spec-ready',
      triggeredBy: 'agent:spec-writer',
    });
    await vi.advanceTimersByTimeAsync(TRACKER_WRITE_TIMEOUT_MS);
    const result = await pending;

    expect(result.currentStage).toBe('spec-ready');
    expect(errSpy).toHaveBeenCalled();
    // Timer/spy cleanup happens in afterEach (failure-safe).
  });

  it('is best-effort: an ensureSubStages failure skips setSubStage but still returns the result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.ensureSubStages.mockRejectedValue(new Error('field creation failed'));
    store.transition.mockResolvedValue(itemAt('spec-ready'));

    const result = await transitionItem({
      externalId: 'HLM-1',
      toStage: 'spec-ready',
      triggeredBy: 'agent:spec-writer',
    });

    expect(result.currentStage).toBe('spec-ready');
    expect(adapter.setSubStage).not.toHaveBeenCalled();
  });

  // ── Memoized ensureSubStages ─────────────────────────────────────────────────

  it('runs ensureSubStages only once across multiple transitions on the same adapter', async () => {
    store.transition.mockResolvedValue(itemAt('spec-ready'));
    await transitionItem({ externalId: 'HLM-1', toStage: 'spec-ready', triggeredBy: 'agent:a' });
    store.transition.mockResolvedValue(itemAt('plan-ready'));
    await transitionItem({ externalId: 'HLM-1', toStage: 'plan-ready', triggeredBy: 'agent:b' });

    expect(adapter.ensureSubStages).toHaveBeenCalledTimes(1);
    expect(adapter.setSubStage).toHaveBeenCalledTimes(2);
  });

  it('re-runs ensureSubStages after a failure (memo evicts the rejected ensure)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.ensureSubStages
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    store.transition.mockResolvedValue(itemAt('spec-ready'));

    // First transition: ensure rejects → writeback aborts before setSubStage.
    await transitionItem({ externalId: 'HLM-1', toStage: 'spec-ready', triggeredBy: 'agent:a' });
    // Second transition: memo was evicted, ensure retried and succeeds.
    await transitionItem({ externalId: 'HLM-1', toStage: 'spec-ready', triggeredBy: 'agent:b' });

    expect(adapter.ensureSubStages).toHaveBeenCalledTimes(2);
    expect(adapter.setSubStage).toHaveBeenCalledTimes(1);
  });
});

// ── forceTransitionItem ───────────────────────────────────────────────────────

describe('forceTransitionItem', () => {
  it('writes the forced stage back to the tracker (rollback path)', async () => {
    store.forceTransition.mockResolvedValue(itemAt('plan-ready'));

    const result = await forceTransitionItem({
      externalId: 'HLM-1',
      fromStage: 'in-development',
      toStage: 'plan-ready',
      triggeredBy: 'manual:rollback',
    });

    expect(result.currentStage).toBe('plan-ready');
    expect(store.forceTransition).toHaveBeenCalledTimes(1);
    expect(adapter.setSubStage).toHaveBeenCalledWith('HLM-1', 'plan-ready');
  });
});

// ── createItem ────────────────────────────────────────────────────────────────

describe('createItem', () => {
  it('writes the initial stage label back to the tracker for a non-tracker create', async () => {
    store.create.mockResolvedValue(itemAt('discovery', 'HLM-2'));

    const result = await createItem({
      externalId: 'HLM-2',
      productSlug: 'test-product',
      triggeredBy: 'human:lhpaul',
    });

    expect(result.currentStage).toBe('discovery');
    expect(adapter.setSubStage).toHaveBeenCalledWith('HLM-2', 'discovery');
  });

  it('does NOT write back for a tracker-originated create (anti-echo)', async () => {
    store.create.mockResolvedValue(itemAt('discovery', 'HLM-2'));

    await createItem({
      externalId: 'HLM-2',
      productSlug: 'test-product',
      triggeredBy: 'webhook:github-projects',
    });

    expect(adapter.setSubStage).not.toHaveBeenCalled();
  });
});
