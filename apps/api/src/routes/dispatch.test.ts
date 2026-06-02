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
    readiness_gate: 'skip',
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

const {
  mockGetProductRegistry,
  mockGet,
  mockTransition,
  mockCreateRuntime,
  mockGetIssueTrackerAdapter,
} = vi.hoisted(() => ({
  mockGetProductRegistry: vi.fn(),
  mockGet: vi.fn(),
  mockTransition: vi.fn(),
  mockCreateRuntime: vi.fn(),
  mockGetIssueTrackerAdapter: vi.fn(),
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
    getIssueTrackerAdapter: mockGetIssueTrackerAdapter,
  };
});

// Replace ClaudeCodeRuntime with a MockAgentRuntime whose sideEffects write the
// spec file the spec-writer handler expects to find on disk.
vi.mock('../services/runtime-factory.js', () => ({
  createRuntimeForProduct: mockCreateRuntime,
}));

// Mock only checkProductReadiness from @helm/orchestrator; everything else
// (MockAgentRuntime, dispatchStageHandler, resolveSpecialistId, …) stays real.
const { mockCheckReadiness } = vi.hoisted(() => ({ mockCheckReadiness: vi.fn() }));
vi.mock('@helm/orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@helm/orchestrator')>();
  return { ...real, checkProductReadiness: mockCheckReadiness };
});

/** Clones the default product with a specific readiness_gate mode. */
const productWithGate = (gate: 'skip' | 'warn' | 'required', slug = 'test-product'): Product => {
  const base = makeProduct(slug);
  return { ...base, workflow: { ...base.workflow, readiness_gate: gate } };
};

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
  // Default: no tracker task available — fetchTask degrades to null (spec written
  // without a ## Task section), matching the behaviour exercised by most tests.
  mockGetIssueTrackerAdapter.mockRejectedValue(new Error('no tracker configured'));
  // Default readiness: ready. The default product uses readiness_gate:'skip', so
  // the gate never invokes this — it only matters for the gate-specific tests.
  mockCheckReadiness.mockResolvedValue({ ready: true, missingContext: [] });

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

/**
 * Installs a spec-writing MockAgentRuntime whose spawn() records the prompt it
 * receives, so a test can assert what the dispatcher injected (e.g. the ## Task
 * section built from the issue tracker adapter).
 */
const captureSpecWriterPrompt = (): { current: string | undefined } => {
  const captured: { current: string | undefined } = { current: undefined };
  mockCreateRuntime.mockImplementation((_product: Product, externalId: string, workdir: string) => {
    const runtime = new MockAgentRuntime({
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
    });
    const originalSpawn = runtime.spawn.bind(runtime);
    runtime.spawn = (params) => {
      captured.current = params.prompt;
      return originalSpawn(params);
    };
    return runtime;
  });
  return captured;
};

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

    // Wait for the background job to finish so afterEach cleanup doesn't race
    // with sideEffects still writing files into dataDir.
    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(body.jobId);
        expect(job?.status).not.toBe('running');
      },
      { timeout: 5000 },
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
    // Use a deferred promise to hold the first job's sideEffects open so the
    // job is guaranteed to still be 'running' when the second dispatch arrives.
    let releaseSideEffect!: () => void;
    const sideEffectGate = new Promise<void>((resolve) => {
      releaseSideEffect = resolve;
    });

    mockCreateRuntime.mockImplementationOnce(
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
            // Block until the test explicitly releases the gate.
            await sideEffectGate;
            const id = basename(dir);
            await mkdir(join(dir, 'specs'), { recursive: true });
            await writeFile(join(dir, 'specs', `${id}.md`), `# ${id}\n`);
            void workdir;
          },
        }),
    );

    // First dispatch — job enters 'running' and stays there (gate is held).
    const res1 = await dispatch('test-product', 'issue_1');
    expect(res1.status).toBe(202);
    const { jobId: runningJobId } = (await res1.json()) as { jobId: string };

    // Second dispatch while the first job is still running → must be 409.
    const res2 = await dispatch('test-product', 'issue_1');
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { error: string; runningJobId: string };
    expect(body2.error).toContain('already running');
    expect(body2.runningJobId).toBe(runningJobId);

    // Release the gate so the background job can complete and the test exits cleanly.
    releaseSideEffect();

    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();

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

    // Wait for the background job to complete (transition is called after sideEffects
    // finish, so this also ensures no files are still being written into dataDir).
    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });

    expect(mockCreateRuntime).toHaveBeenCalledOnce();
    expect(mockCreateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ product: expect.objectContaining({ slug: 'test-product' }) }),
      'issue_1',
      expect.stringContaining(join('worktrees', 'test-product', 'issue_1')),
    );
  });

  it('injects a ## Task section from the resolved issue tracker adapter', async () => {
    // The dispatch route resolves the tracker adapter polymorphically via
    // getIssueTrackerAdapter() (was hardcoded to GitHub Projects). Mock it for a
    // Linear-style product and assert the spec-writer prompt carries the task.
    mockGetIssueTrackerAdapter.mockResolvedValue({
      getItem: vi
        .fn()
        .mockResolvedValue({ title: 'Add tenant onboarding flow', body: 'As a landlord…' }),
    });
    const prompt = captureSpecWriterPrompt();

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });

    expect(mockGetIssueTrackerAdapter).toHaveBeenCalled();
    expect(prompt.current).toContain('## Task');
    expect(prompt.current).toContain('Add tenant onboarding flow');
  });

  // ── feedback field (ADR-024 early-stage remediators) ───────────────────────

  it('returns 400 when spec-remediator is dispatched without feedback', async () => {
    const res = await dispatch('test-product', 'issue_1', { specialistId: 'spec-remediator' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid request body');
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('returns 400 when plan-remediator feedback is blank whitespace', async () => {
    const res = await dispatch('test-product', 'issue_1', {
      specialistId: 'plan-remediator',
      feedback: '   ',
    });
    // min(1) trims to empty → superRefine rejects (blank is not meaningful feedback).
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid request body');
  });

  it('returns 400 when feedback exceeds the 10000-char limit', async () => {
    const res = await dispatch('test-product', 'issue_1', {
      specialistId: 'spec-remediator',
      feedback: 'x'.repeat(10001),
    });
    expect(res.status).toBe(400);
  });

  it('accepts spec-remediator dispatch with valid feedback (202)', async () => {
    mockGet.mockResolvedValue(makeItem('issue_1', 'spec-draft'));

    const res = await dispatch('test-product', 'issue_1', {
      specialistId: 'spec-remediator',
      feedback: 'Tighten the acceptance criteria.',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; status: string };
    expect(body.status).toBe('running');

    // Drain the background job so afterEach cleanup doesn't race with it. The
    // job will error (no GITHUB_TOKEN / no real PR), but the route accepted it.
    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(body.jobId);
        expect(job?.status).not.toBe('running');
      },
      { timeout: 5000 },
    );
  });

  it('ignores feedback for a normal (non-remediator) dispatch', async () => {
    // feedback is optional for non-remediator specialists — accepted, just unused.
    const res = await dispatch('test-product', 'issue_1', { feedback: 'some note' });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });
  });

  it('writes the spec without a ## Task section when the adapter throws (no dispatch failure)', async () => {
    // fetchTask is best-effort: an adapter init/network error must NOT fail the
    // whole dispatch — the spec-writer falls back to writing without a ## Task.
    mockGetIssueTrackerAdapter.mockRejectedValue(new Error('adapter init failed'));
    const prompt = captureSpecWriterPrompt();

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).toBe('done');
      },
      { timeout: 5000 },
    );

    expect(mockTransition).toHaveBeenCalled();
    expect(prompt.current).toBeDefined();
    expect(prompt.current).not.toContain('## Task');
  });

  // ── Product-readiness gate (ADR-026) ───────────────────────────────────────

  it('does not run the readiness gate when readiness_gate is skip', async () => {
    // Default product is skip — even an unready product would not be checked.
    mockCheckReadiness.mockResolvedValue({
      ready: false,
      missingContext: [{ repo: 'test-org/test', role: 'app', missing: ['README.md'] }],
    });

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    expect(mockCheckReadiness).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });
  });

  it('returns 422 with missing_context when readiness_gate is required and the product is not ready', async () => {
    mockGetProductRegistry.mockResolvedValue([productWithGate('required')]);
    const missingContext = [
      { repo: 'test-org/test', role: 'app', missing: ['README.md', 'agent instructions (…)'] },
    ];
    mockCheckReadiness.mockResolvedValue({ ready: false, missingContext });

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; missing_context: unknown };
    expect(body.error).toContain('not ready');
    expect(body.missing_context).toEqual(missingContext);
    // 422 returns before job creation — no background work.
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockCreateRuntime).not.toHaveBeenCalled();
  });

  it('proceeds (202) when readiness_gate is required and the product is ready', async () => {
    mockGetProductRegistry.mockResolvedValue([productWithGate('required')]);
    mockCheckReadiness.mockResolvedValue({ ready: true, missingContext: [] });

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    expect(mockCheckReadiness).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });
  });

  it('returns 502 when readiness_gate is required and the check throws (infra failure)', async () => {
    mockGetProductRegistry.mockResolvedValue([productWithGate('required')]);
    mockCheckReadiness.mockRejectedValue(new Error('GitHub 500'));

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Readiness check failed');
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('proceeds (202) when readiness_gate is warn even if the product is not ready', async () => {
    mockGetProductRegistry.mockResolvedValue([productWithGate('warn')]);
    mockCheckReadiness.mockResolvedValue({
      ready: false,
      missingContext: [{ repo: 'test-org/test', role: 'app', missing: ['README.md'] }],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);
    expect(mockCheckReadiness).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('proceeds (202) when readiness_gate is warn and the check throws', async () => {
    mockGetProductRegistry.mockResolvedValue([productWithGate('warn')]);
    mockCheckReadiness.mockRejectedValue(new Error('GitHub 500'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(mockTransition).toHaveBeenCalled(), { timeout: 5000 });
    warnSpy.mockRestore();
  });

  it('bypasses the gate for non-spec-writer dispatches even when required (remediator)', async () => {
    // spec-remediator at spec-draft is operator-triggered; it is the fix for
    // missing context, so gating it would be self-defeating (ADR-026).
    mockGetProductRegistry.mockResolvedValue([productWithGate('required')]);
    mockGet.mockResolvedValue(makeItem('issue_1', 'spec-draft'));
    mockCheckReadiness.mockResolvedValue({
      ready: false,
      missingContext: [{ repo: 'test-org/test', role: 'app', missing: ['README.md'] }],
    });

    const res = await dispatch('test-product', 'issue_1', {
      specialistId: 'spec-remediator',
      feedback: 'Tighten the acceptance criteria.',
    });
    expect(res.status).toBe(202);
    expect(mockCheckReadiness).not.toHaveBeenCalled();

    // Drain the background job (it will error — no real PR — but the route accepted it).
    const { getJobStore } = await import('../services/index.js');
    const jobStore = await getJobStore();
    const { jobId } = (await res.json()) as { jobId: string };
    await vi.waitFor(
      async () => {
        const job = await jobStore.getJob(jobId);
        expect(job?.status).not.toBe('running');
      },
      { timeout: 5000 },
    );
  });
});
