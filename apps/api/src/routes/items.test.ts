import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';

// Stub the tracker adapter so writeback (ADR-033) is deterministic and never
// touches the network — getProductConfig/getItemStore stay real (filesystem).
const { mockSetSubStage, mockEnsureSubStages } = vi.hoisted(() => ({
  mockSetSubStage: vi.fn().mockResolvedValue(undefined),
  mockEnsureSubStages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getIssueTrackerAdapter: vi
      .fn()
      .mockResolvedValue({ setSubStage: mockSetSubStage, ensureSubStages: mockEnsureSubStages }),
  };
});

// Minimal valid product config used for all item endpoint tests.
// productSlug 'example-app' comes from here, not from request bodies.
const PRODUCT_YAML = `
helm_version: "0"
product:
  slug: example-app
  name: Example App
issue_tracker:
  provider: github_projects
  org: example-org
  project_number: 42
code_repos:
  - url: https://github.com/example-org/example-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/example-org/example-app-knowledge
  default_branch: main
workflow:
  stages_enabled: [in-development, released]
specialists:
  'spec-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'plan-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  'code-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'security-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'test-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  spec-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  code-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

let testDir: string;
let savedEnv: { dataDir: string | undefined; knowledgePath: string | undefined };

beforeEach(async () => {
  _resetForTests();
  testDir = join(tmpdir(), `helm-items-api-${randomUUID()}`);
  await mkdir(join(testDir, 'data'), { recursive: true });
  await mkdir(join(testDir, 'knowledge', '.helm'), { recursive: true });
  await writeFile(join(testDir, 'knowledge', '.helm', 'product.yaml'), PRODUCT_YAML);

  savedEnv = {
    dataDir: process.env.HELM_DATA_DIR,
    knowledgePath: process.env.HELM_KNOWLEDGE_REPO_PATH,
  };
  process.env.HELM_DATA_DIR = join(testDir, 'data');
  process.env.HELM_KNOWLEDGE_REPO_PATH = join(testDir, 'knowledge');
});

afterEach(async () => {
  _resetForTests();
  await rm(testDir, { recursive: true, force: true });
  if (savedEnv.dataDir === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = savedEnv.dataDir;
  if (savedEnv.knowledgePath === undefined) delete process.env.HELM_KNOWLEDGE_REPO_PATH;
  else process.env.HELM_KNOWLEDGE_REPO_PATH = savedEnv.knowledgePath;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const post = (url: string, body: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── POST /api/items ───────────────────────────────────────────────────────────

describe('POST /api/items', () => {
  it('returns 201 with item at discovery and productSlug from Product config', async () => {
    const res = await post('/api/items', { externalId: 'HLM-1', triggeredBy: 'human:test' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      currentStage: string;
      productSlug: string;
      externalId: string;
    };
    expect(body.currentStage).toBe('discovery');
    expect(body.externalId).toBe('HLM-1');
    // productSlug comes from product.yaml ('example-app'), NOT from request body
    expect(body.productSlug).toBe('example-app');
  });

  it('returns 400 when body is missing required fields', async () => {
    const res = await post('/api/items', {});
    expect(res.status).toBe(400);
  });

  it('returns 400 when externalId contains invalid characters', async () => {
    const res = await post('/api/items', { externalId: '../escape', triggeredBy: 't' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when item with same externalId already exists', async () => {
    await post('/api/items', { externalId: 'HLM-1', triggeredBy: 't' });
    const res = await post('/api/items', { externalId: 'HLM-1', triggeredBy: 't' });
    expect(res.status).toBe(409);
  });

  it('returns 500 with generic message when product config cannot be loaded', async () => {
    delete process.env.HELM_KNOWLEDGE_REPO_PATH;
    const res = await post('/api/items', { externalId: 'HLM-1', triggeredBy: 't' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    // Generic message — internal details (env var names, paths) are logged server-side only
    expect(body.error).toBe('Failed to load product config');
  });
});

// ── GET /api/items ────────────────────────────────────────────────────────────

describe('GET /api/items', () => {
  it('returns empty array when no items exist', async () => {
    const res = await app.request('/api/items');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns all items after creation', async () => {
    await post('/api/items', { externalId: 'HLM-1', triggeredBy: 't' });
    await post('/api/items', { externalId: 'HLM-2', triggeredBy: 't' });
    const res = await app.request('/api/items');
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(2);
  });
});

// ── POST /api/items/:externalId/transitions ───────────────────────────────────

describe('POST /api/items/:externalId/transitions', () => {
  beforeEach(async () => {
    await post('/api/items', { externalId: 'HLM-1', triggeredBy: 'human:test' });
  });

  it('returns 200 with updated stage on a valid transition', async () => {
    const res = await post('/api/items/HLM-1/transitions', {
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currentStage: string };
    expect(body.currentStage).toBe('spec-draft');
    // Writeback (ADR-033): an agent-triggered transition is not tracker-originated,
    // so the new stage is pushed back to the tracker.
    expect(mockSetSubStage).toHaveBeenCalledWith('HLM-1', 'spec-draft');
  });

  it('returns 400 when body is missing required fields', async () => {
    const res = await post('/api/items/HLM-1/transitions', {});
    expect(res.status).toBe(400);
  });

  it('returns 400 when toStage is not a valid WorkflowStage', async () => {
    const res = await post('/api/items/HLM-1/transitions', {
      toStage: 'not-a-real-stage',
      triggeredBy: 't',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when item does not exist', async () => {
    const res = await post('/api/items/HLM-999/transitions', {
      toStage: 'spec-draft',
      triggeredBy: 't',
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 when transition is not permitted by the state machine', async () => {
    // discovery → released is not a valid transition
    const res = await post('/api/items/HLM-1/transitions', {
      toStage: 'released',
      triggeredBy: 't',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("'released'");
  });
});
