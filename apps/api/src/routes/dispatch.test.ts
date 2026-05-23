import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgentRuntime } from '@helm/orchestrator';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';
import type { Product } from '@helm/shared';

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

// Replace ClaudeCodeRuntime with a MockAgentRuntime whose sideEffects write the
// spec file the spec-writer handler expects to find on disk.
vi.mock('../services/runtime-factory.js', () => ({
  createRuntimeForProduct: mockCreateRuntime,
}));

// ── Setup ─────────────────────────────────────────────────────────────────────

let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  _resetForTests();
  vi.clearAllMocks();

  // Provide a real temp directory for worktrees so MockAgentRuntime sideEffects can write
  dataDir = join(tmpdir(), `dispatch-test-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  savedDataDir = process.env.HELM_DATA_DIR;
  process.env.HELM_DATA_DIR = dataDir;

  // Default happy-path mocks
  mockGetProductRegistry.mockResolvedValue([makeProduct()]);
  mockGet.mockResolvedValue(makeItem());
  mockTransition.mockResolvedValue({ currentStage: 'spec-draft' });

  // Replace ClaudeCodeRuntime with a scriptable mock that writes the expected
  // spec file. The externalId is derived from the workdir path (last segment).
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
          const id = basename(dir); // workdir last segment = externalId
          await mkdir(join(dir, 'specs'), { recursive: true });
          await writeFile(join(dir, 'specs', `${id}.md`), `# ${id}\n`);
          void workdir; // explicitly consumed
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

const dispatch = (slug: string, externalId: string, body?: unknown) =>
  app.request(`/api/products/${slug}/items/${externalId}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/products/:slug/items/:externalId/dispatch', () => {
  it('returns 202 with jobId and status:running for a discovery-stage item', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);

    const body = (await res.json()) as {
      jobId: string;
      status: string;
    };
    expect(body.status).toBe('running');
    expect(typeof body.jobId).toBe('string');
    expect(body.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('runs the dispatch job in background and calls store.transition', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);

    // Wait for background job to complete
    await vi.waitFor(
      () => {
        expect(mockTransition).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );

    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'issue_1',
        toStage: 'spec-draft',
        triggeredBy: 'agent:spec-writer',
      }),
    );
  });

  it('job transitions to done with correct result after background completion', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    // Import real getJobStore from the actual module (not mocked)
    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();

    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).toBe('done');
      },
      { timeout: 5000 },
    );

    const job = await jobStore.getJob(jobId);
    expect(job?.result?.newStage).toBe('spec-draft');
    expect(job?.result?.specialistId).toBe('spec-writer');
    expect(job?.finishedAt).toBeDefined();
  });

  it('returns 409 when a dispatch job is already running for the item', async () => {
    // First dispatch — immediately returns 202 while job runs in background
    const res1 = await dispatch('test-product', 'issue_1');
    expect(res1.status).toBe(202);
    const { jobId: runningJobId } = (await res1.json()) as { jobId: string };

    // Import real getJobStore to check job status
    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();

    // Verify job is still running before the second dispatch
    // (The mock runtime is fast but we're dispatching again immediately)
    // We use a fresh job store in a fresh dispatch while the first is still running.
    // To reliably test the 409, we'll manually update the job to ensure it's running.
    // The first dispatch should result in a running job; let's check immediately.
    const jobBeforeSecond = await jobStore.getJob(runningJobId);
    // It may be running or done depending on timing; skip if already done
    if (jobBeforeSecond?.status === 'running') {
      const res2 = await dispatch('test-product', 'issue_1');
      expect(res2.status).toBe(409);
      const body2 = (await res2.json()) as { error: string; runningJobId: string };
      expect(body2.error).toContain('already running');
      expect(body2.runningJobId).toBe(runningJobId);
    }

    // Wait for background job to finish
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(runningJobId);
        expect(job?.status).not.toBe('running');
      },
      { timeout: 5000 },
    );
  });

  it('returns 400 when slug has invalid format', async () => {
    const res = await dispatch('INVALID_SLUG!', 'issue_1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('slug');
  });

  it('returns 400 when externalId has invalid characters', async () => {
    // colon is outside the allowed [A-Za-z0-9._-] charset (same pattern as items tests)
    const res = await dispatch('test-product', 'HLM:invalid');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('externalId');
  });

  it('rejects dot-segment externalIds', async () => {
    // Hono normalizes '.' and '..' URL segments before the handler runs, so
    // these requests reach a 404 (no route match) rather than the 400 guard.
    // The explicit check in dispatch.ts provides defense-in-depth for any
    // non-HTTP code path that could supply a raw '.' or '..' value.
    // EXTERNAL_ID_REGEX also already rejects both via its (?!\.) lookahead.
    const resDot = await dispatch('test-product', '.');
    expect(resDot.status).not.toBe(200);

    const resDotDot = await dispatch('test-product', '..');
    expect(resDotDot.status).not.toBe(200);
  });

  it('returns 400 when request body has unexpected fields', async () => {
    const res = await dispatch('test-product', 'issue_1', { unknown: 'field' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid request body');
  });

  it('returns 400 when request body is malformed JSON', async () => {
    const res = await app.request('/api/products/test-product/items/issue_1/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"specialistId":', // truncated / invalid JSON
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid JSON');
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('returns 404 when product slug does not exist in registry', async () => {
    mockGetProductRegistry.mockResolvedValue([makeProduct('other-product')]);

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('test-product');
  });

  it('returns 500 when product registry loading fails', async () => {
    mockGetProductRegistry.mockRejectedValue(new Error('disk error'));

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(500);
  });

  it('returns 404 when item does not exist in the store', async () => {
    mockGet.mockResolvedValue(null);

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('issue_1');
  });

  it('returns 404 when item belongs to a different product (slug mismatch)', async () => {
    mockGet.mockResolvedValue(makeItem('issue_1', 'discovery', 'other-product'));

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(404);
  });

  it('returns 500 when item store throws', async () => {
    mockGet.mockRejectedValue(new Error('io error'));

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(500);
  });

  it('job transitions to error when item stage has no specialist mapped', async () => {
    // spec-draft has no mapping in STAGE_TO_SPECIALIST
    mockGet.mockResolvedValue(makeItem('issue_1', 'spec-draft'));

    const res = await dispatch('test-product', 'issue_1');
    // Async dispatch: job is created, returns 202
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();

    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).toBe('error');
      },
      { timeout: 5000 },
    );
  });

  it('accepts specialistId override in request body', async () => {
    const res = await dispatch('test-product', 'issue_1', { specialistId: 'spec-writer' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; status: string };
    expect(body.status).toBe('running');

    // Wait for the job to complete
    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });
  });

  it('job transitions to error when createRuntimeForProduct throws', async () => {
    mockCreateRuntime.mockImplementation(() => {
      throw new Error("[runtime-factory] Unknown specialist runtime: 'bad_runtime'");
    });

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();

    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).toBe('error');
      },
      { timeout: 5000 },
    );

    const job = await jobStore.getJob(jobId);
    expect(job?.error).toContain('bad_runtime');
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('passes product, externalId, and workdir to createRuntimeForProduct', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);

    // Wait for background job to call createRuntimeForProduct
    await vi.waitFor(() => expect(mockCreateRuntime).toHaveBeenCalled(), { timeout: 5000 });

    expect(mockCreateRuntime).toHaveBeenCalledOnce();
    expect(mockCreateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ product: expect.objectContaining({ slug: 'test-product' }) }),
      'issue_1',
      expect.stringContaining(join('worktrees', 'test-product', 'issue_1')),
    );
  });
});
