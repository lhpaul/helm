import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgentRuntime } from '@helm/orchestrator';
import { app } from '../app.js';
import { _resetForTests, getJobStore } from '../services/index.js';
import type { Product } from '@helm/shared';
import type { Job } from '../services/job-store.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeProduct = (slug = 'test-product'): Product => ({
  helm_version: '0',
  product: { slug, name: 'Test Product' },
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
    readiness_gate: 'skip',
    final_stage: 'released',
  },
  specialists: {
    'spec-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'plan-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
    'code-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'security-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'test-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'spec-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'plan-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
});

const makeItem = (
  externalId = 'issue_1',
  currentStage = 'discovery',
  productSlug = 'test-product',
) => ({
  externalId,
  productSlug,
  currentStage,
  history: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetProductRegistry, mockGet, mockTransition, mockCreateRuntime } = vi.hoisted(() => ({
  mockGetProductRegistry: vi.fn(),
  mockGet: vi.fn(),
  mockTransition: vi.fn(),
  mockCreateRuntime: vi.fn(),
}));

vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getProductRegistry: mockGetProductRegistry,
    getItemStore: vi.fn().mockResolvedValue({
      get: mockGet,
      transition: mockTransition,
    }),
  };
});

vi.mock('../services/runtime-factory.js', () => ({
  createRuntimeForProduct: mockCreateRuntime,
}));

// ── Setup ─────────────────────────────────────────────────────────────────────

let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  _resetForTests();
  vi.clearAllMocks();

  dataDir = join(tmpdir(), `jobs-test-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  savedDataDir = process.env.HELM_DATA_DIR;
  process.env.HELM_DATA_DIR = dataDir;

  mockGetProductRegistry.mockResolvedValue([makeProduct()]);
  mockGet.mockResolvedValue(makeItem());
  mockTransition.mockResolvedValue({ currentStage: 'spec-draft', history: [] });

  mockCreateRuntime.mockImplementation(
    (_product: Product, externalId: string, workdir: string) =>
      new MockAgentRuntime({
        messages: [
          {
            role: 'agent',
            content: `[mock] Writing spec for ${externalId}`,
            costUsd: 0,
            timestamp: new Date().toISOString(),
          },
        ],
        sideEffects: async (dir) => {
          const id = basename(dir);
          await mkdir(join(dir, 'specs'), { recursive: true });
          await writeFile(join(dir, 'specs', `${id}.md`), `# ${id}\n`);
          void workdir;
        },
      }),
  );
});

afterEach(async () => {
  _resetForTests();
  await rm(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = savedDataDir;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const getJob = (jobId: string) => app.request(`/api/jobs/${jobId}`, { method: 'GET' });

const listJobs = (slug: string, externalId: string) =>
  app.request(`/api/products/${slug}/items/${externalId}/jobs`, { method: 'GET' });

const dispatch = (slug: string, externalId: string, body?: unknown) =>
  app.request(`/api/products/${slug}/items/${externalId}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

// ── GET /api/jobs/:jobId ──────────────────────────────────────────────────────

describe('GET /api/jobs/:jobId', () => {
  it('returns 200 with the job for a known jobId', async () => {
    // Create a job via the dispatch endpoint and wait for completion
    const dispatchRes = await dispatch('test-product', 'issue_1');
    expect(dispatchRes.status).toBe(202);
    const { jobId } = (await dispatchRes.json()) as { jobId: string };

    // Wait for job completion to avoid race in afterEach cleanup
    const jobStore = await getJobStore();
    await vi.waitFor(
      async () => {
        const j = await jobStore.getJob(jobId);
        expect(j?.status).not.toBe('running');
      },
      { timeout: 5000 },
    );

    const res = await getJob(jobId);
    expect(res.status).toBe(200);

    const job = (await res.json()) as Job;
    expect(job.jobId).toBe(jobId);
    expect(job.productSlug).toBe('test-product');
    expect(job.externalId).toBe('issue_1');
  });

  it('returns 404 for an unknown (but valid) jobId', async () => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await getJob(fakeId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(fakeId);
  });

  it('returns 400 for a malformed jobId', async () => {
    const res = await getJob('not-a-uuid');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid jobId');
  });

  it('returns 400 for an empty-looking path segment', async () => {
    // A very short string that doesn't match UUID v4
    const res = await getJob('abc');
    expect(res.status).toBe(400);
  });

  it('returns 500 when the job file is corrupted (invalid JSON)', async () => {
    // Write a valid UUID filename with corrupt contents to trigger readJson to throw.
    const jobsDir = join(dataDir, 'jobs');
    await mkdir(jobsDir, { recursive: true });
    const fakeId = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(jobsDir, `${fakeId}.json`), '{ invalid json }');

    const res = await getJob(fakeId);
    expect(res.status).toBe(500);
  });
});

// ── GET /api/products/:slug/items/:externalId/jobs ────────────────────────────

describe('GET /api/products/:slug/items/:externalId/jobs', () => {
  it('returns 200 with an empty array when no jobs exist', async () => {
    const res = await listJobs('test-product', 'issue_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Job[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('returns 200 with the list of jobs for a known item', async () => {
    // Create a job via dispatch and wait for completion to avoid race in afterEach
    const dispatchRes = await dispatch('test-product', 'issue_1');
    expect(dispatchRes.status).toBe(202);
    const { jobId } = (await dispatchRes.json()) as { jobId: string };

    // Wait for the background job to finish so afterEach cleanup doesn't race with file writes
    const jobStore = await getJobStore();
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).not.toBe('running');
      },
      { timeout: 5000 },
    );

    const res = await listJobs('test-product', 'issue_1');
    expect(res.status).toBe(200);
    const jobs = (await res.json()) as Job[];
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((j) => j.jobId === jobId)).toBe(true);
  });

  it('returns 400 for an invalid slug', async () => {
    const res = await listJobs('INVALID!', 'issue_1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('slug');
  });

  it('returns 400 for an invalid externalId', async () => {
    const res = await listJobs('test-product', 'bad:id');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('externalId');
  });

  it('returns 500 when the jobs directory contains a corrupted file', async () => {
    // Any corrupt JSON in the jobs dir causes listJobsForItem to throw.
    const jobsDir = join(dataDir, 'jobs');
    await mkdir(jobsDir, { recursive: true });
    const fakeId = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(jobsDir, `${fakeId}.json`), '{ invalid json }');

    const res = await listJobs('test-product', 'issue_1');
    expect(res.status).toBe(500);
  });
});

// ── Integration: full async dispatch flow ─────────────────────────────────────

describe('full async dispatch flow', () => {
  it('POST dispatch → 202 + jobId → poll GET job → status:done with correct result', async () => {
    // 1. Dispatch
    const dispatchRes = await dispatch('test-product', 'issue_1');
    expect(dispatchRes.status).toBe(202);
    const { jobId, status: initialStatus } = (await dispatchRes.json()) as {
      jobId: string;
      status: string;
    };
    expect(initialStatus).toBe('running');

    // 2. Poll until done
    const jobStore = await getJobStore();
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).toBe('done');
      },
      { timeout: 5000 },
    );

    // 3. Verify job via GET endpoint
    const jobRes = await getJob(jobId);
    expect(jobRes.status).toBe(200);
    const job = (await jobRes.json()) as Job;
    expect(job.status).toBe('done');
    expect(job.result?.newStage).toBe('spec-draft');
    expect(job.result?.specialistId).toBe('spec-writer');
    expect(job.finishedAt).toBeDefined();

    // 4. Verify transition was called
    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'issue_1',
        toStage: 'spec-draft',
        triggeredBy: 'agent:spec-writer',
      }),
    );
  });
});
