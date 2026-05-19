import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    getItemStore: vi.fn().mockResolvedValue({
      get: mockGet,
      transition: mockTransition,
    }),
  };
});

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
  it('returns 200 with dispatch result for a discovery-stage item', async () => {
    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      specialistId: string;
      status: string;
      newStage: string;
      costUsd: number;
      durationMs: number;
    };
    expect(body.specialistId).toBe('spec-writer');
    expect(body.status).toBe('done');
    expect(body.newStage).toBe('spec-draft');
    expect(body.costUsd).toBeGreaterThanOrEqual(0);
    expect(typeof body.durationMs).toBe('number');
  });

  it('returns 200 and calls store.transition after successful dispatch', async () => {
    await dispatch('test-product', 'issue_1');

    expect(mockTransition).toHaveBeenCalledOnce();
    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'issue_1',
        toStage: 'spec-draft',
        triggeredBy: 'agent:spec-writer',
      }),
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

  it('returns 400 when item stage has no specialist mapped', async () => {
    // spec-draft has no mapping in STAGE_TO_SPECIALIST
    mockGet.mockResolvedValue(makeItem('issue_1', 'spec-draft'));

    const res = await dispatch('test-product', 'issue_1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No specialist mapped');
  });

  it('accepts specialistId override in request body', async () => {
    const res = await dispatch('test-product', 'issue_1', { specialistId: 'spec-writer' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specialistId: string };
    expect(body.specialistId).toBe('spec-writer');
  });
});
