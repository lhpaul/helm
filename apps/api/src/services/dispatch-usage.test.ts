import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResult, AgentSession, IAgentRuntime, SpawnParams } from '@helm/orchestrator';
import type { Product } from '@helm/shared';
import type { ItemState } from './types.js';

// Wiring test for #151: runDispatchJob wraps the runtime so each session leaves
// a usage record on the job, without changing the dispatch outcome.

const { mockDispatch, mockCreateRuntime } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockCreateRuntime: vi.fn(),
}));

vi.mock('@helm/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@helm/orchestrator')>();
  return { ...actual, dispatchStageHandler: mockDispatch };
});
vi.mock('./runtime-factory.js', () => ({ createRuntimeForProduct: mockCreateRuntime }));
vi.mock('./index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./index.js')>();
  return {
    ...real,
    getItemStore: vi.fn().mockResolvedValue({ get: vi.fn().mockResolvedValue(null) }),
    getProductRegistry: vi.fn().mockResolvedValue([]),
  };
});

import { runDispatchJob } from './dispatch-scheduler.js';
import { _resetForTests, getJobStore } from './index.js';

const product = { specialists: { 'spec-writer': { runtime: 'codex' } } } as unknown as Product;
const item = {
  externalId: 'issue_1',
  productSlug: 'prod',
  currentStage: 'code-review',
  history: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as ItemState;

const reported: AgentResult = {
  status: 'done',
  finalOutput: 'out',
  totalCostUsd: 0,
  durationMs: 5,
  usage: {
    tokens: { input: 9, output: 3, cacheRead: 1, cacheCreation: null, reasoning: 2 },
    costUsd: null,
    costSource: 'unknown',
  },
};

function runtimeWith(result: AgentResult): IAgentRuntime {
  return {
    async spawn(): Promise<AgentSession> {
      return {
        id: 's',
        status: 'running',
        onMessage: () => {},
        send: async () => {},
        cancel: async () => {},
        wait: async () => result,
      };
    },
  };
}

const spawnParams = (specialistId: string): SpawnParams => ({
  specialistId,
  prompt: 'p',
  workdir: '/w',
  productSlug: 'prod',
  externalId: 'issue_1',
});

let dataDir: string;
let saved: string | undefined;

beforeEach(async () => {
  _resetForTests();
  vi.clearAllMocks();
  dataDir = join(tmpdir(), `dispatch-usage-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  saved = process.env.HELM_DATA_DIR;
  process.env.HELM_DATA_DIR = dataDir;
});

afterEach(async () => {
  _resetForTests();
  await rm(dataDir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = saved;
});

async function run(specialistId: string, sessions: string[]) {
  const store = await getJobStore();
  const job = await store.createJob({ productSlug: 'prod', externalId: 'issue_1', specialistId });
  mockDispatch.mockImplementation(async (_input, _product, runtime: IAgentRuntime) => {
    await Promise.all(sessions.map(async (id) => (await runtime.spawn(spawnParams(id))).wait()));
    return { specialistId, status: 'done', costUsd: 0, durationMs: 1, cyclesCompleted: 2 };
  });
  await runDispatchJob(job, {
    product,
    item,
    workdir: '/w',
    dataRoot: dataDir,
    specialistId,
    feedback: undefined,
    githubToken: undefined,
  });
  return (await store.getJob(job.jobId))!;
}

describe('runDispatchJob usage capture (#151)', () => {
  it('persists one record per session on the job, stamped with the job stage and runtime', async () => {
    mockCreateRuntime.mockReturnValue(runtimeWith(reported));

    const job = await run('reviewer-fanout', ['code-reviewer', 'security-reviewer', 'remediator']);

    expect(job.status).toBe('done');
    expect(job.result?.cyclesCompleted).toBe(2);
    expect(job.usage).toHaveLength(3);
    expect(job.usage?.map((r) => r.specialistId).sort()).toEqual([
      'code-reviewer',
      'remediator',
      'security-reviewer',
    ]);
    expect(job.usage?.every((r) => r.stage === 'review' && r.jobId === job.jobId)).toBe(true);
    expect(job.usage?.every((r) => r.runtime === 'codex' && r.costUsd === null)).toBe(true);
    expect(job.usageCaptureFailures).toBe(0);
  });

  it('attributes early-loop review sessions to the job stage (spec), not review', async () => {
    mockCreateRuntime.mockReturnValue(runtimeWith(reported));
    const job = await run('spec-draft-reviewer', ['code-reviewer']);
    expect(job.usage?.[0]?.stage).toBe('spec');
  });

  it('keeps the usage written by sessions when the dispatch throws', async () => {
    mockCreateRuntime.mockReturnValue(runtimeWith(reported));
    const store = await getJobStore();
    const job = await store.createJob({
      productSlug: 'prod',
      externalId: 'issue_1',
      specialistId: 'implementer',
    });
    mockDispatch.mockImplementation(async (_i, _p, runtime: IAgentRuntime) => {
      await (await runtime.spawn(spawnParams('implementer'))).wait();
      throw new Error('boom');
    });

    await runDispatchJob(job, {
      product,
      item,
      workdir: '/w',
      dataRoot: dataDir,
      specialistId: 'implementer',
      feedback: undefined,
      githubToken: undefined,
    });

    const after = (await store.getJob(job.jobId))!;
    expect(after.status).toBe('error');
    expect(after.usage).toHaveLength(1);
  });

  it('a failed usage write never fails the dispatch and bumps usageCaptureFailures', async () => {
    mockCreateRuntime.mockReturnValue(runtimeWith(reported));
    const store = await getJobStore();
    const append = vi.spyOn(store, 'appendUsage').mockRejectedValue(new Error('disk full'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const job = await run('implementer', ['implementer']);

    expect(append).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('done');
    expect(job.usage).toEqual([]);
    expect(job.usageCaptureFailures).toBe(1);
    errSpy.mockRestore();
  });

  it('double failure (write and counter) still succeeds; only the log remains', async () => {
    mockCreateRuntime.mockReturnValue(runtimeWith(reported));
    const store = await getJobStore();
    vi.spyOn(store, 'appendUsage').mockRejectedValue(new Error('unwritable'));
    vi.spyOn(store, 'recordUsageCaptureFailure').mockRejectedValue(new Error('unwritable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const job = await run('implementer', ['implementer']);

    expect(job.status).toBe('done');
    expect(job.usage).toEqual([]);
    expect(job.usageCaptureFailures).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
