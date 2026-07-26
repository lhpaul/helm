import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';
import type { Product } from '@helm/shared';

const { mockGetItem, mockGetIssueTrackerAdapter, mockUpdateJob, mockCreateJobIfNoRunning } =
  vi.hoisted(() => ({
    mockGetItem: vi.fn(),
    mockGetIssueTrackerAdapter: vi.fn(),
    mockUpdateJob: vi.fn(),
    mockCreateJobIfNoRunning: vi.fn(),
  }));

vi.mock('./index.js', () => ({
  getIssueTrackerAdapter: (...args: unknown[]) => mockGetIssueTrackerAdapter(...args),
  getJobStore: vi.fn().mockResolvedValue({
    updateJob: mockUpdateJob,
    createJobIfNoRunning: mockCreateJobIfNoRunning,
  }),
  getProductRegistry: vi.fn(),
  getItemStore: vi.fn(),
}));

vi.mock('./runtime-factory.js', () => ({
  createRuntimeForProduct: vi.fn(),
}));

vi.mock('./item-service.js', () => ({
  transitionItem: vi.fn(),
}));

vi.mock('@helm/orchestrator', () => ({
  dispatchStageHandler: vi.fn(),
  resolveSpecialistId: vi.fn(),
}));

import {
  clearPendingExternalReview,
  resumePendingExternalReview,
  resumePendingExternalReviewByRevision,
  runDispatchJob,
  scheduleItemDispatch,
  sweepExpiredPendingExternalReviews,
} from './dispatch-scheduler.js';
import { dispatchStageHandler, resolveSpecialistId } from '@helm/orchestrator';
import { getItemStore, getProductRegistry } from './index.js';
import { getReviewDispatchOutbox } from './review-dispatch-outbox.js';

const baseProduct = {
  product: { slug: 'test-product', name: 'Test Product' },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' }],
} as unknown as Product;

describe('runDispatchJob fetchTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueTrackerAdapter.mockResolvedValue({ getItem: mockGetItem });
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);
  });

  it('returns null when the tracker item is missing', async () => {
    mockGetItem.mockResolvedValue(null);

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: { externalId: 'LEA-1', productSlug: 'test', currentStage: 'spec-ready' } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: undefined,
      feedback: undefined,
      githubToken: undefined,
    });

    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      fetchTask?: (id: string) => Promise<unknown>;
    };
    await expect(options.fetchTask?.('LEA-1')).resolves.toBeNull();
  });

  it('re-throws non-not-found tracker errors instead of returning null', async () => {
    mockGetItem.mockRejectedValue(new Error('tracker unavailable'));

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: { externalId: 'LEA-1', productSlug: 'test', currentStage: 'spec-ready' } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: undefined,
      feedback: undefined,
      githubToken: undefined,
    });

    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      fetchTask?: (id: string) => Promise<unknown>;
    };
    await expect(options.fetchTask?.('LEA-1')).rejects.toThrow('tracker unavailable');
  });

  it('returns null for GitHubNotFoundError and LinearNotFoundError', async () => {
    for (const err of [new GitHubNotFoundError('missing'), new LinearNotFoundError('missing')]) {
      mockGetItem.mockRejectedValueOnce(err);

      await runDispatchJob({ jobId: 'job-1' } as never, {
        product: { product: { slug: 'test' } } as never,
        item: {
          externalId: 'LEA-1',
          productSlug: 'test',
          currentStage: 'spec-ready',
        } as never,
        workdir: '/tmp/ws',
        dataRoot: '/tmp/data',
        specialistId: undefined,
        feedback: undefined,
        githubToken: undefined,
      });

      const options = vi.mocked(dispatchStageHandler).mock.calls.at(-1)![4] as {
        fetchTask?: (id: string) => Promise<unknown>;
      };
      await expect(options.fetchTask?.('LEA-1')).resolves.toBeNull();
    }
  });
});

describe('runDispatchJob lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueTrackerAdapter.mockResolvedValue({ getItem: mockGetItem });
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);
  });

  it('records a done job when dispatchStageHandler succeeds', async () => {
    vi.mocked(dispatchStageHandler).mockResolvedValue({
      status: 'done',
      prUrl: 'https://x/pull/1',
    } as never);

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: { externalId: 'LEA-1', productSlug: 'test', currentStage: 'code-review' } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: undefined,
      feedback: undefined,
      githubToken: undefined,
    });

    expect(mockUpdateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'done',
        result: expect.objectContaining({ status: 'done' }),
        finishedAt: expect.any(String),
      }),
    );
  });

  it('passes persisted product decisions into dispatch context', async () => {
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test',
        currentStage: 'code-review',
        resolvedProductDecisions: [
          {
            fingerprint: 'kind=product_decision|title=pick direction|paths=|markers=',
            conflictKind: 'product_decision',
            conflictTitle: 'Pick direction',
            scope: { paths: [], markers: [] },
            chosenOption: 'Option A',
            recordedAt: '2026-07-22T12:00:00.000Z',
            source: {
              provider: 'github',
              owner: 'o',
              repo: 'r',
              prNumber: 42,
              authorLogin: 'maintainer',
            },
          },
        ],
      } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: 'reviewer-fanout',
      feedback: undefined,
      githubToken: 'token',
    });

    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      resolvedProductDecisions?: unknown[];
    };
    expect(options.resolvedProductDecisions).toEqual([
      expect.objectContaining({
        fingerprint: 'kind=product_decision|title=pick direction|paths=|markers=',
        chosenOption: 'Option A',
      }),
    ]);
  });

  it('reloads decisions from ItemStore when the queued snapshot is stale', async () => {
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    const decision = {
      fingerprint: 'kind=product_decision|title=pick direction|paths=|markers=',
      conflictKind: 'product_decision' as const,
      conflictTitle: 'Pick direction',
      scope: { paths: [] as string[], markers: [] as string[] },
      chosenOption: 'Option A',
      recordedAt: '2026-07-22T12:00:00.000Z',
      source: {
        provider: 'github' as const,
        owner: 'o',
        repo: 'r',
        prNumber: 42,
        authorLogin: 'maintainer',
      },
    };
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test',
        currentStage: 'code-review',
        resolvedProductDecisions: [decision],
      }),
    } as never);

    // Queued snapshot has no ledger — decision was persisted after enqueue.
    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test',
        currentStage: 'code-review',
      } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: 'reviewer-fanout',
      feedback: undefined,
      githubToken: 'token',
    });

    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      resolvedProductDecisions?: unknown[];
      loadResolvedProductDecisions?: () => Promise<unknown[]>;
    };
    expect(options.resolvedProductDecisions).toEqual([decision]);
    expect(typeof options.loadResolvedProductDecisions).toBe('function');
    await expect(options.loadResolvedProductDecisions?.()).resolves.toEqual([decision]);
    // Defensive copy: mutating the returned array must not touch store state.
    const loaded = await options.loadResolvedProductDecisions!();
    loaded.push({ ...decision, fingerprint: 'mutated' });
    await expect(options.loadResolvedProductDecisions?.()).resolves.toEqual([decision]);
  });

  it('fails closed when the live decision reload cannot find the item', async () => {
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        externalId: 'LEA-1',
        productSlug: 'test',
        currentStage: 'code-review',
        resolvedProductDecisions: [],
      })
      .mockResolvedValueOnce(null);
    vi.mocked(getItemStore).mockResolvedValue({ get } as never);

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test',
        currentStage: 'code-review',
      } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: 'reviewer-fanout',
      feedback: undefined,
      githubToken: 'token',
    });

    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      loadResolvedProductDecisions?: () => Promise<unknown[]>;
    };
    await expect(options.loadResolvedProductDecisions?.()).rejects.toThrow(
      /Item not found while reloading settled decisions/,
    );
  });

  it('records an error job when dispatchStageHandler throws', async () => {
    vi.mocked(dispatchStageHandler).mockRejectedValue(new Error('dispatch failed'));

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: { product: { slug: 'test' } } as never,
      item: { externalId: 'LEA-1', productSlug: 'test', currentStage: 'code-review' } as never,
      workdir: '/tmp/ws',
      dataRoot: '/tmp/data',
      specialistId: undefined,
      feedback: undefined,
      githubToken: undefined,
    });

    expect(mockUpdateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'error',
        error: 'dispatch failed',
        finishedAt: expect.any(String),
      }),
    );
  });
});

describe('scheduleItemDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-github-token';
    mockGetIssueTrackerAdapter.mockResolvedValue({ getItem: mockGetItem });
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('reviewer-fanout');
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it('returns a generic reason when the product is missing', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([]);

    await expect(
      scheduleItemDispatch({
        productSlug: 'missing',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Unable to schedule dispatch' });
  });

  it('returns a generic reason when the item is missing', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({ get: vi.fn().mockResolvedValue(null) } as never);

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Unable to schedule dispatch' });
  });

  it('returns a generic reason when no specialist maps to the stage', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'released',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue(undefined);

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'Unable to schedule dispatch',
    });
  });

  it('schedules spec-draft with no resolved specialist when early loop is enabled', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-draft',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue(undefined);
    mockCreateJobIfNoRunning.mockResolvedValue({ job: { jobId: 'job-early-spec' } });

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: true, jobId: 'job-early-spec' });

    await vi.waitFor(() => {
      expect(dispatchStageHandler).toHaveBeenCalled();
    });
    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      specialistId?: string;
    };
    expect(options.specialistId).toBeUndefined();
  });

  it('schedules plan-draft with no resolved specialist when early loop is enabled', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'plan-draft',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue(undefined);
    mockCreateJobIfNoRunning.mockResolvedValue({ job: { jobId: 'job-early-plan' } });

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: true, jobId: 'job-early-plan' });

    await vi.waitFor(() => {
      expect(dispatchStageHandler).toHaveBeenCalled();
    });
    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      specialistId?: string;
    };
    expect(options.specialistId).toBeUndefined();
  });

  it('keeps explicit specialist routing authoritative when early loop is enabled', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-draft',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('spec-remediator');
    mockCreateJobIfNoRunning.mockResolvedValue({ job: { jobId: 'job-explicit-specialist' } });

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'spec-remediator',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: true, jobId: 'job-explicit-specialist' });

    expect(resolveSpecialistId).toHaveBeenCalledWith('spec-draft', 'spec-remediator');
    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith(
      expect.objectContaining({ specialistId: 'spec-remediator' }),
    );
    await vi.waitFor(() => {
      expect(dispatchStageHandler).toHaveBeenCalled();
    });
    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      specialistId?: string;
    };
    expect(options.specialistId).toBe('spec-remediator');
  });

  it('does not schedule spec-draft-reviewer for spec-ready even when early loop is enabled', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-ready',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('spec-draft-reviewer');

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'spec-draft-reviewer',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Unable to schedule dispatch' });

    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
    expect(dispatchStageHandler).not.toHaveBeenCalled();
  });

  it('does not schedule plan-draft-reviewer for plan-ready even when early loop is enabled', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'plan-ready',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('plan-draft-reviewer');

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'plan-draft-reviewer',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Unable to schedule dispatch' });

    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
    expect(dispatchStageHandler).not.toHaveBeenCalled();
  });

  it('returns a generic reason when path segments are unsafe', async () => {
    await expect(
      scheduleItemDispatch({
        productSlug: '../escape',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Unable to schedule dispatch' });

    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('returns a generic reason when GITHUB_TOKEN is not configured', async () => {
    delete process.env.GITHUB_TOKEN;
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      }),
    } as never);

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'Unable to schedule dispatch',
    });

    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('schedules a dispatch job when preconditions are met', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      }),
    } as never);
    mockCreateJobIfNoRunning.mockResolvedValue({ job: { jobId: 'job-99' } });
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({ scheduled: true, jobId: 'job-99' });

    await vi.waitFor(() => {
      expect(mockUpdateJob).toHaveBeenCalled();
    });
  });

  it('passes the resolved specialist to runDispatchJob when specialistId is omitted', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      }),
    } as never);
    mockCreateJobIfNoRunning.mockResolvedValue({ job: { jobId: 'job-99' } });

    await scheduleItemDispatch({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      triggeredBy: 'test',
    });

    await vi.waitFor(() => {
      expect(dispatchStageHandler).toHaveBeenCalled();
    });

    const options = vi.mocked(dispatchStageHandler).mock.calls[0]![4] as {
      specialistId?: string;
    };
    expect(options.specialistId).toBe('reviewer-fanout');
  });

  it('returns conflict when a dispatch job is already running', async () => {
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      }),
    } as never);
    mockCreateJobIfNoRunning.mockResolvedValue({
      conflict: true,
      runningJobId: 'job-running',
    });

    await expect(
      scheduleItemDispatch({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        triggeredBy: 'test',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'Unable to schedule dispatch',
    });
  });
});

describe('pending external review readiness cleanup', () => {
  let dataRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dataRoot = await mkdtemp(join(tmpdir(), 'helm-dispatch-scheduler-'));
    process.env.HELM_DATA_DIR = dataRoot;
    process.env.GITHUB_TOKEN = 'test-github-token';
    vi.mocked(getProductRegistry).mockResolvedValue([baseProduct]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('reviewer-fanout');
  });

  afterEach(async () => {
    delete process.env.HELM_DATA_DIR;
    delete process.env.GITHUB_TOKEN;
    await rm(dataRoot, { recursive: true, force: true });
  });

  async function putPending(
    expiresAt = '2099-01-01T00:00:00.000Z',
    specialistId = 'reviewer-fanout',
  ) {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const intent = await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId,
      provider: 'haystack',
      reason: 'analysis_pending',
      prNumber: 42,
      targetRevision: 'sha-1',
      expiresAt,
      triggeredBy: 'test',
    });
    return { outbox, intent };
  }

  it('clears a matching pending external review intent without scheduling', async () => {
    const { outbox } = await putPending();

    await expect(
      clearPendingExternalReview({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-1',
      }),
    ).resolves.toBe(true);

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('does not clear a pending external review intent for the wrong revision', async () => {
    const { outbox, intent } = await putPending();

    await expect(
      clearPendingExternalReview({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-2',
      }),
    ).resolves.toBe(false);

    await expect(outbox.get('test-product', 'LEA-1', 'pending_external_review')).resolves.toEqual(
      intent,
    );
  });

  it('removes expired pending external review intents on readiness', async () => {
    const { outbox } = await putPending('2000-01-01T00:00:00.000Z');

    await expect(
      resumePendingExternalReview({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Pending external review expired' });

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('sweeps expired pending external review intents without a readiness webhook', async () => {
    const { outbox } = await putPending('2000-01-01T00:00:00.000Z');

    await expect(sweepExpiredPendingExternalReviews()).resolves.toBe(1);

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('resumes pending external review by revision when PR metadata is unavailable', async () => {
    const { outbox } = await putPending();
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000001',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'reviewer-fanout',
        status: 'running',
        targetRevision: 'sha-1',
        startedAt: '2026-07-22T10:00:00.000Z',
      },
    });

    await expect(
      resumePendingExternalReviewByRevision({
        productSlug: 'test-product',
        provider: 'haystack',
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({
      scheduled: true,
      jobId: '00000000-0000-4000-8000-000000000001',
      externalId: 'LEA-1',
    });

    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'reviewer-fanout',
      targetRevision: 'sha-1',
    });
    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
  });

  it('resumes deferred spec draft review with the original specialist', async () => {
    const { outbox } = await putPending('2099-01-01T00:00:00.000Z', 'spec-draft-reviewer');
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-draft',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('spec-draft-reviewer');
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000002',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'spec-draft-reviewer',
        status: 'running',
        targetRevision: 'sha-1',
        startedAt: '2026-07-22T10:00:00.000Z',
      },
    });

    await expect(
      resumePendingExternalReviewByRevision({
        productSlug: 'test-product',
        provider: 'haystack',
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({
      scheduled: true,
      jobId: '00000000-0000-4000-8000-000000000002',
      externalId: 'LEA-1',
    });

    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'spec-draft-reviewer',
      targetRevision: 'sha-1',
    });
    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
  });

  it('removes pending external review after duplicate readiness delivery', async () => {
    const { outbox } = await putPending();
    mockCreateJobIfNoRunning.mockResolvedValue({
      duplicate: true,
      existingJobId: 'job-existing',
    });

    await expect(
      resumePendingExternalReview({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Duplicate target revision' });

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
  });

  it('handles concurrent duplicate readiness notifications with one scheduled job', async () => {
    const { outbox } = await putPending();
    let firstRelease: (() => void) | undefined;
    let secondRelease: (() => void) | undefined;
    const entered: Array<() => void> = [];
    mockCreateJobIfNoRunning.mockImplementation(async () => {
      const callNumber = entered.length + 1;
      await new Promise<void>((resolve) => {
        entered.push(resolve);
        if (callNumber === 1) firstRelease = resolve;
        if (callNumber === 2) secondRelease = resolve;
      });
      if (callNumber === 1) {
        return {
          job: {
            jobId: '00000000-0000-4000-8000-000000000001',
            productSlug: 'test-product',
            externalId: 'LEA-1',
            specialistId: 'reviewer-fanout',
            status: 'running',
            targetRevision: 'sha-1',
            startedAt: '2026-07-22T10:00:00.000Z',
          },
        };
      }
      return { duplicate: true, existingJobId: '00000000-0000-4000-8000-000000000001' };
    });

    const outcomesPromise = Promise.all([
      resumePendingExternalReviewByRevision({
        productSlug: 'test-product',
        provider: 'haystack',
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready:a',
      }),
      resumePendingExternalReviewByRevision({
        productSlug: 'test-product',
        provider: 'haystack',
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready:b',
      }),
    ]);

    await vi.waitFor(() => expect(entered).toHaveLength(2));
    firstRelease?.();
    secondRelease?.();

    const outcomes = await outcomesPromise;

    expect(outcomes.filter((outcome) => outcome.scheduled)).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) => !outcome.scheduled && outcome.reason === 'Duplicate target revision',
      ),
    ).toHaveLength(1);
    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
  });

  it('parks a review_dispatch intent when readiness races a running job', async () => {
    const { outbox } = await putPending();
    mockCreateJobIfNoRunning.mockResolvedValue({
      conflict: true,
      runningJobId: 'job-running',
      runningTargetRevision: 'sha-1',
    });

    await expect(
      resumePendingExternalReview({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'Job already running — queued review dispatch for replay after exit',
    });

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
    const parked = await outbox.get('test-product', 'LEA-1', 'review_dispatch');
    expect(parked).toMatchObject({
      kind: 'review_dispatch',
      specialistId: 'reviewer-fanout',
      targetRevision: 'sha-1',
      prNumber: 42,
      triggeredBy: 'test:ready:awaiting-job-exit',
    });
  });
});

describe('runDispatchJob failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueTrackerAdapter.mockResolvedValue({ getItem: mockGetItem });
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue(null),
    } as never);
  });

  it('still completes when jobStore.updateJob fails in the error branch', async () => {
    vi.mocked(dispatchStageHandler).mockRejectedValue(new Error('dispatch failed'));
    mockUpdateJob.mockRejectedValueOnce(new Error('job store unavailable'));

    await expect(
      runDispatchJob({ jobId: 'job-1' } as never, {
        product: { product: { slug: 'test' } } as never,
        item: { externalId: 'LEA-1', productSlug: 'test', currentStage: 'code-review' } as never,
        workdir: '/tmp/ws',
        dataRoot: '/tmp/data',
        specialistId: undefined,
        feedback: undefined,
        githubToken: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(mockUpdateJob).toHaveBeenCalled();
  });
});
