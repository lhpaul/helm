/**
 * Focused tests for the option-forwarding logic in the dispatch route:
 * GITHUB_TOKEN trimming, dataRoot, and githubToken wiring.
 *
 * Uses a module-level mock of dispatchStageHandler to capture what options
 * the route passes to the orchestrator without running the full spec-writer flow.
 */
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';
import type { Product } from '@helm/shared';
import type { DispatchOptions } from '@helm/orchestrator';

// ── Module-level mock of dispatchStageHandler ─────────────────────────────────
// Captures the options argument without running real dispatch logic.
// vi.hoisted is required because vi.mock factories are hoisted to module top.

const { mockDispatch } = vi.hoisted(() => ({
  mockDispatch: vi.fn().mockResolvedValue({
    specialistId: 'spec-writer',
    status: 'done' as const,
    newStage: 'spec-draft' as const,
    costUsd: 0,
    durationMs: 0,
  }),
}));

vi.mock('@helm/orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@helm/orchestrator')>();
  return { ...real, dispatchStageHandler: mockDispatch };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeProduct = (): Product => ({
  helm_version: '0',
  product: { slug: 'test-product', name: 'Test Product' },
  issue_tracker: {
    provider: 'github_projects',
    org: 'test-org',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [{ url: 'https://github.com/test-org/test', default_branch: 'main', role: 'app' }],
  knowledge_repo: { url: 'https://github.com/test-org/knowledge', default_branch: 'main' },
  workflow: {
    stages_enabled: ['discovery', 'spec-draft', 'released'],
    designer_gate: 'skip',
    qa_gate: 'skip',
  },
  specialists: {
    spec_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    plan_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
    code_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    security_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    test_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    remediation: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
});

const makeItem = () => ({
  externalId: 'issue_1',
  productSlug: 'test-product',
  currentStage: 'discovery',
  history: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetProductRegistry, mockGet, mockTransition } = vi.hoisted(() => ({
  mockGetProductRegistry: vi.fn(),
  mockGet: vi.fn(),
  mockTransition: vi.fn(),
}));

vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getProductRegistry: mockGetProductRegistry,
    getItemStore: vi.fn().mockResolvedValue({ get: mockGet, transition: mockTransition }),
  };
});

vi.mock('../services/runtime-factory.js', () => ({
  createRuntimeForProduct: vi.fn().mockReturnValue({
    spawn: vi.fn().mockResolvedValue({
      wait: vi
        .fn()
        .mockResolvedValue({ status: 'done', totalCostUsd: 0, durationMs: 0, finalOutput: '' }),
    }),
  }),
}));

// ── Setup ─────────────────────────────────────────────────────────────────────

let dataDir: string;
let savedDataDir: string | undefined;
let savedGithubToken: string | undefined;

beforeEach(async () => {
  _resetForTests();
  vi.clearAllMocks();

  dataDir = join(tmpdir(), `dispatch-opts-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  savedDataDir = process.env.HELM_DATA_DIR;
  savedGithubToken = process.env.GITHUB_TOKEN;
  process.env.HELM_DATA_DIR = dataDir;
  delete process.env.GITHUB_TOKEN;

  mockGetProductRegistry.mockResolvedValue([makeProduct()]);
  mockGet.mockResolvedValue(makeItem());
  mockTransition.mockResolvedValue({ currentStage: 'spec-draft' });
});

afterEach(async () => {
  _resetForTests();
  await rm(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = savedDataDir;
  if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedGithubToken;
});

const dispatch = (slug: string, externalId: string) =>
  app.request(`/api/products/${slug}/items/${externalId}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

// ── Helper: fully drain the background job ────────────────────────────────────
// Waiting for mockDispatch.toHaveBeenCalled() only guarantees the mock was
// *invoked* — jobStore.updateJob (which writes to disk) runs AFTER mockDispatch
// resolves.  We must also wait for the job to leave 'running' state, otherwise
// afterEach's rm() races with the in-flight write and throws ENOTEMPTY.
const waitForJobDone = async (jobId: string) => {
  const { getJobStore } = await import('../services/index.js');
  const jobStore = await getJobStore();
  await vi.waitFor(
    async () => {
      const job = await jobStore.getJob(jobId);
      expect(job?.status).not.toBe('running');
    },
    { timeout: 5000 },
  );
};

const capturedOptions = (): DispatchOptions => {
  const call = mockDispatch.mock.calls[0] as unknown[];
  return call[4] as DispatchOptions;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dispatch route option forwarding', () => {
  it('forwards dataRoot derived from HELM_DATA_DIR to dispatchStageHandler', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    await waitForJobDone(jobId);

    expect(capturedOptions().dataRoot).toBe(dataDir);
  });

  it('forwards undefined githubToken when GITHUB_TOKEN is not set', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    await waitForJobDone(jobId);

    expect(capturedOptions().githubToken).toBeUndefined();
  });

  it('trims GITHUB_TOKEN whitespace before forwarding to dispatchStageHandler', async () => {
    process.env.GITHUB_TOKEN = '  padded-token  ';

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    await waitForJobDone(jobId);

    expect(capturedOptions().githubToken).toBe('padded-token');
  });

  it('forwards non-padded GITHUB_TOKEN unchanged', async () => {
    process.env.GITHUB_TOKEN = 'clean-token';

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    await waitForJobDone(jobId);

    expect(capturedOptions().githubToken).toBe('clean-token');
  });
});
