import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';

const { mockGetItem, mockGetIssueTrackerAdapter, mockUpdateJob } = vi.hoisted(() => ({
  mockGetItem: vi.fn(),
  mockGetIssueTrackerAdapter: vi.fn(),
  mockUpdateJob: vi.fn(),
}));

vi.mock('./index.js', () => ({
  getIssueTrackerAdapter: (...args: unknown[]) => mockGetIssueTrackerAdapter(...args),
  getJobStore: vi.fn().mockResolvedValue({ updateJob: mockUpdateJob }),
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

import { runDispatchJob } from './dispatch-scheduler.js';
import { dispatchStageHandler } from '@helm/orchestrator';

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
