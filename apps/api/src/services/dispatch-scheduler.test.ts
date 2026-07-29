import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';
import type { Product } from '@helm/shared';

const {
  mockGetItem,
  mockGetIssueTrackerAdapter,
  mockUpdateJob,
  mockCreateJobIfNoRunning,
  mockResolveOpenPrMetadata,
  mockResolveOpenPrMetadataForRepo,
} = vi.hoisted(() => ({
  mockGetItem: vi.fn(),
  mockGetIssueTrackerAdapter: vi.fn(),
  mockUpdateJob: vi.fn(),
  mockCreateJobIfNoRunning: vi.fn(),
  mockResolveOpenPrMetadata: vi.fn(),
  mockResolveOpenPrMetadataForRepo: vi.fn(),
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

vi.mock('./github-pr.js', () => ({
  parseGitHubRepoUrl: (url: string) => {
    const parsed = new URL(url);
    const [owner, repo] = parsed.pathname.replace(/^\/+/, '').split('/');
    return { owner, repo: repo?.replace(/\.git$/, '') };
  },
  resolveOpenPrMetadata: (...args: unknown[]) => mockResolveOpenPrMetadata(...args),
  resolveOpenPrMetadataForRepo: (...args: unknown[]) => mockResolveOpenPrMetadataForRepo(...args),
}));

import {
  clearPendingExternalReview,
  replayPendingReviewDispatchForItem,
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
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
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

  it('passes a production Bugbot loader when Bugbot external review is configured', async () => {
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);

    await runDispatchJob({ jobId: 'job-1' } as never, {
      product: {
        product: { slug: 'test' },
        review: { external: { provider: 'bugbot' } },
      } as never,
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
      externalReviewDeps?: { loadBugbotReview?: unknown };
    };
    expect(typeof options.externalReviewDeps?.loadBugbotReview).toBe('function');
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
    expect(options.specialistId).toBe('spec-draft-reviewer');
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
    expect(options.specialistId).toBe('plan-draft-reviewer');
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
    ).resolves.toEqual({ scheduled: false, reason: 'Draft reviewer no longer applicable' });

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
    ).resolves.toEqual({ scheduled: false, reason: 'Draft reviewer no longer applicable' });

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
    mockResolveOpenPrMetadataForRepo.mockResolvedValue({
      owner: 'o',
      repo: 'k',
      number: 42,
      headRef: 'helm/spec/LEA-1',
      headSha: 'sha-live',
      htmlUrl: 'https://github.com/o/k/pull/42',
    });
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
    options: { omitSpecialistId?: boolean } = {},
  ) {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const intent = await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      ...(options.omitSpecialistId ? {} : { specialistId }),
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

  it('infers the spec draft reviewer for legacy pending external reviews without a specialist', async () => {
    const { outbox } = await putPending('2099-01-01T00:00:00.000Z', 'reviewer-fanout', {
      omitSpecialistId: true,
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000003',
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
      jobId: '00000000-0000-4000-8000-000000000003',
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

  it('infers the plan draft reviewer for legacy pending external reviews without a specialist', async () => {
    const { outbox } = await putPending('2099-01-01T00:00:00.000Z', 'reviewer-fanout', {
      omitSpecialistId: true,
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000004',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'plan-draft-reviewer',
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
      jobId: '00000000-0000-4000-8000-000000000004',
      externalId: 'LEA-1',
    });

    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'plan-draft-reviewer',
      targetRevision: 'sha-1',
    });
    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
  });

  it('removes pending external review when an explicit draft reviewer is no longer applicable', async () => {
    const { outbox } = await putPending('2099-01-01T00:00:00.000Z', 'spec-draft-reviewer');
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-draft',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('spec-draft-reviewer');

    await expect(
      resumePendingExternalReview({
        productSlug: 'test-product',
        externalId: 'LEA-1',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({ scheduled: false, reason: 'Draft reviewer no longer applicable' });

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('removes pending external review when a draft reviewer intent is now post-draft', async () => {
    const { outbox } = await putPending('2099-01-01T00:00:00.000Z', 'plan-draft-reviewer');
    vi.mocked(getProductRegistry).mockResolvedValue([
      { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
    ]);
    vi.mocked(getItemStore).mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      }),
    } as never);
    vi.mocked(resolveSpecialistId).mockReturnValue('plan-draft-reviewer');

    await expect(
      resumePendingExternalReviewByRevision({
        productSlug: 'test-product',
        provider: 'haystack',
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'Draft reviewer no longer applicable',
      externalId: 'LEA-1',
    });

    await expect(
      outbox.get('test-product', 'LEA-1', 'pending_external_review'),
    ).resolves.toBeNull();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('removes pending external review after duplicate revision readiness delivery', async () => {
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

  it('removes pending external review after duplicate readiness delivery', async () => {
    const { outbox } = await putPending();
    mockCreateJobIfNoRunning.mockResolvedValue({
      duplicate: true,
      existingJobId: '00000000-0000-4000-8000-000000000001',
    });

    await expect(
      resumePendingExternalReviewByRevision({
        productSlug: 'test-product',
        provider: 'haystack',
        targetRevision: 'sha-1',
        triggeredBy: 'test:ready',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'Duplicate target revision',
      externalId: 'LEA-1',
    });

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

  it('parks the inferred draft reviewer when early-loop readiness races a running job', async () => {
    const { outbox } = await putPending('2099-01-01T00:00:00.000Z', 'reviewer-fanout', {
      omitSpecialistId: true,
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
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
    await expect(
      outbox.get('test-product', 'LEA-1', 'review_dispatch', 'plan-draft-reviewer'),
    ).resolves.toMatchObject({
      kind: 'review_dispatch',
      specialistId: 'plan-draft-reviewer',
      targetRevision: 'sha-1',
      prNumber: 42,
      triggeredBy: 'test:ready:awaiting-job-exit',
    });
  });

  it('refreshes live PR metadata when replaying a parked draft-review dispatch', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      prNumber: 42,
      targetRevision: 'sha-1',
      triggeredBy: 'legacy',
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000004',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'spec-draft-reviewer',
        status: 'running',
        targetRevision: 'sha-live',
        startedAt: '2026-07-22T10:00:00.000Z',
      },
    });

    await runDispatchJob({ jobId: 'job-current' } as never, {
      product: { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-draft',
      } as never,
      workdir: '/tmp/ws',
      dataRoot,
      specialistId: 'spec-draft-reviewer',
      feedback: undefined,
      githubToken: 'token',
    });

    expect(mockResolveOpenPrMetadataForRepo).toHaveBeenCalledWith({
      repo: { owner: 'o', repo: 'k' },
      prNumber: 42,
      githubToken: 'token',
    });
    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'spec-draft-reviewer',
      targetRevision: 'sha-live',
    });
    await expect(
      outbox.get('test-product', 'LEA-1', 'review_dispatch', 'spec-draft-reviewer'),
    ).resolves.toBeNull();
  });

  it('replays a queued plan-draft reviewer dispatch after the stage transition', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'plan-draft-reviewer',
      prNumber: 43,
      targetRevision: 'sha-webhook',
      triggeredBy: 'webhook:plan-pr-sync:awaiting-plan-draft',
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    mockResolveOpenPrMetadataForRepo.mockResolvedValue({
      headRef: 'helm/plan/LEA-1',
      headSha: 'sha-live-plan',
    });
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000005',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'plan-draft-reviewer',
        status: 'running',
        targetRevision: 'sha-live-plan',
        startedAt: '2026-07-22T10:00:00.000Z',
      },
    });

    await runDispatchJob({ jobId: 'job-current' } as never, {
      product: { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'plan-draft',
      } as never,
      workdir: '/tmp/ws',
      dataRoot,
      specialistId: 'plan-writer',
      feedback: undefined,
      githubToken: 'token',
    });

    expect(mockResolveOpenPrMetadataForRepo).toHaveBeenCalledWith({
      repo: { owner: 'o', repo: 'k' },
      prNumber: 43,
      githubToken: 'token',
    });
    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'plan-draft-reviewer',
      targetRevision: 'sha-live-plan',
    });
    await expect(
      outbox.get('test-product', 'LEA-1', 'review_dispatch', 'plan-draft-reviewer'),
    ).resolves.toBeNull();
  });

  it('clears stale draft review_dispatch intents when the item has left the draft stage', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'spec-draft-reviewer',
      prNumber: 44,
      targetRevision: 'sha-stale',
      triggeredBy: 'webhook:spec-pr-sync:awaiting-spec-draft',
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    mockResolveOpenPrMetadataForRepo.mockResolvedValue({
      headRef: 'helm/spec/LEA-1',
      headSha: 'sha-stale',
    });

    await runDispatchJob({ jobId: 'job-current' } as never, {
      product: { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-ready',
      } as never,
      workdir: '/tmp/ws',
      dataRoot,
      specialistId: 'spec-writer',
      feedback: undefined,
      githubToken: 'token',
    });

    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
    await expect(
      outbox.get('test-product', 'LEA-1', 'review_dispatch', 'spec-draft-reviewer'),
    ).resolves.toBeNull();
  });

  it('clears stage-inferred draft intents on knowledge headRef mismatch without code-repo lookup', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      prNumber: 44,
      targetRevision: 'sha-stale',
      triggeredBy: 'legacy:unknown',
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    mockResolveOpenPrMetadataForRepo.mockResolvedValue({
      headRef: 'helm/plan/LEA-1',
      headSha: 'sha-other',
    });

    await runDispatchJob({ jobId: 'job-current' } as never, {
      product: { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      } as never,
      workdir: '/tmp/ws',
      dataRoot,
      specialistId: 'code-remediator',
      feedback: undefined,
      githubToken: 'token',
    });

    expect(mockResolveOpenPrMetadataForRepo).toHaveBeenCalled();
    expect(mockResolveOpenPrMetadata).not.toHaveBeenCalled();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
  });

  it('replays impl fanout intents without specialistId even when the item is still in a draft stage', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      prNumber: 80,
      targetRevision: 'sha-impl-parked',
      triggeredBy: 'webhook:impl-pr-sync',
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    mockResolveOpenPrMetadata.mockResolvedValue({
      headRef: 'helm/impl/LEA-1',
      headSha: 'sha-impl-live',
    });
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000080',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'reviewer-fanout',
        status: 'running',
        targetRevision: 'sha-impl-live',
        startedAt: '2026-07-22T10:00:00.000Z',
      },
    });

    await runDispatchJob({ jobId: 'job-current' } as never, {
      product: { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'code-review',
      } as never,
      workdir: '/tmp/ws',
      dataRoot,
      specialistId: 'code-remediator',
      feedback: undefined,
      githubToken: 'token',
    });

    expect(mockResolveOpenPrMetadataForRepo).not.toHaveBeenCalled();
    expect(mockResolveOpenPrMetadata).toHaveBeenCalledWith({
      product: expect.anything(),
      prNumber: 80,
      githubToken: 'token',
    });
    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'reviewer-fanout',
      targetRevision: 'sha-impl-live',
    });
  });

  it('does not switch repositories for stage-inferred legacy draft replay mismatches', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      prNumber: 81,
      targetRevision: 'sha-legacy',
      triggeredBy: 'legacy',
    });
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
    vi.mocked(resolveSpecialistId).mockImplementation(
      (_stage, specialistId) => specialistId as string | undefined,
    );
    vi.mocked(dispatchStageHandler).mockResolvedValue({ status: 'done' } as never);
    mockResolveOpenPrMetadataForRepo.mockResolvedValue({
      headRef: 'helm/impl/LEA-1',
      headSha: 'sha-impl-live',
    });

    await runDispatchJob({ jobId: 'job-current' } as never, {
      product: { ...baseProduct, review: { early_loop: { enabled: true } } } as never,
      item: {
        externalId: 'LEA-1',
        productSlug: 'test-product',
        currentStage: 'spec-draft',
      } as never,
      workdir: '/tmp/ws',
      dataRoot,
      specialistId: 'spec-writer',
      feedback: undefined,
      githubToken: 'token',
    });

    expect(mockResolveOpenPrMetadataForRepo).toHaveBeenCalledWith({
      repo: { owner: 'o', repo: 'k' },
      prNumber: 81,
      githubToken: 'token',
    });
    expect(mockResolveOpenPrMetadata).not.toHaveBeenCalled();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
    await expect(outbox.get('test-product', 'LEA-1')).resolves.toBeNull();
  });

  it('drops parked draft reviewer dispatches when early loop is disabled', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'spec-draft-reviewer',
      prNumber: 42,
      targetRevision: 'sha-parked',
      triggeredBy: 'webhook:spec-pr-sync:awaiting-spec-draft',
    });

    await replayPendingReviewDispatchForItem({
      product: baseProduct,
      productSlug: 'test-product',
      externalId: 'LEA-1',
    });

    expect(mockResolveOpenPrMetadataForRepo).not.toHaveBeenCalled();
    expect(mockResolveOpenPrMetadata).not.toHaveBeenCalled();
    expect(mockCreateJobIfNoRunning).not.toHaveBeenCalled();
    await expect(
      outbox.get('test-product', 'LEA-1', 'review_dispatch', 'spec-draft-reviewer'),
    ).resolves.toBeNull();
  });

  it('still replays parked reviewer-fanout dispatches when early loop is disabled', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'reviewer-fanout',
      prNumber: 80,
      targetRevision: 'sha-impl-parked',
      triggeredBy: 'operator:remediation',
    });
    mockResolveOpenPrMetadata.mockResolvedValue({
      headRef: 'helm/impl/LEA-1',
      headSha: 'sha-impl-live',
    });
    mockCreateJobIfNoRunning.mockResolvedValue({
      job: {
        jobId: '00000000-0000-4000-8000-000000000080',
        productSlug: 'test-product',
        externalId: 'LEA-1',
        specialistId: 'reviewer-fanout',
        status: 'running',
        targetRevision: 'sha-impl-live',
        startedAt: '2026-07-22T10:00:00.000Z',
      },
    });

    await replayPendingReviewDispatchForItem({
      product: baseProduct,
      productSlug: 'test-product',
      externalId: 'LEA-1',
    });

    expect(mockResolveOpenPrMetadataForRepo).not.toHaveBeenCalled();
    expect(mockResolveOpenPrMetadata).toHaveBeenCalledWith({
      product: baseProduct,
      prNumber: 80,
      githubToken: 'test-github-token',
    });
    expect(mockCreateJobIfNoRunning).toHaveBeenCalledWith({
      productSlug: 'test-product',
      externalId: 'LEA-1',
      specialistId: 'reviewer-fanout',
      targetRevision: 'sha-impl-live',
    });
    await expect(
      outbox.get('test-product', 'LEA-1', 'review_dispatch', 'reviewer-fanout'),
    ).resolves.toBeNull();
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
