import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';

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

import { runDispatchJob, scheduleItemDispatch } from './dispatch-scheduler.js';
import { dispatchStageHandler, resolveSpecialistId } from '@helm/orchestrator';
import { getItemStore, getProductRegistry } from './index.js';

const baseProduct = {
  product: { slug: 'test-product', name: 'Test Product' },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' }],
} as never;

describe('runDispatchJob fetchTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueTrackerAdapter.mockResolvedValue({ getItem: mockGetItem });
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
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

describe('runDispatchJob failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueTrackerAdapter.mockResolvedValue({ getItem: mockGetItem });
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
