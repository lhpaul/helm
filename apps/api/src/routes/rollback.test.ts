import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';

// Mirrors items.test.ts: a minimal valid product config. The rollback endpoint
// resolves productSlug ('example-app') from here, not from the request body.
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

const PRODUCT_SLUG = 'example-app';

let testDir: string;
let savedEnv: { dataDir: string | undefined; knowledgePath: string | undefined };

beforeEach(async () => {
  _resetForTests();
  testDir = join(tmpdir(), `helm-rollback-api-${randomUUID()}`);
  await mkdir(join(testDir, 'data', 'items'), { recursive: true });
  await mkdir(join(testDir, 'data', 'jobs'), { recursive: true });
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

// The valid forward chain. Seeding an item at a given stage walks it through the
// transitions endpoint so the persisted state mirrors a real workflow history.
const CHAIN = [
  'spec-draft',
  'spec-ready',
  'plan-draft',
  'plan-ready',
  'in-development',
  'code-review',
] as const;

async function seedItemAt(externalId: string, targetStage: (typeof CHAIN)[number]): Promise<void> {
  const created = await post('/api/items', { externalId, triggeredBy: 'human:test' });
  expect(created.status).toBe(201);
  for (const toStage of CHAIN) {
    const res = await post(`/api/items/${externalId}/transitions`, {
      toStage,
      triggeredBy: 'agent:test',
    });
    expect(res.status).toBe(200);
    if (toStage === targetStage) return;
  }
  throw new Error(`seedItemAt: targetStage "${targetStage}" not reached in CHAIN`);
}

// Writes a job record directly to the jobs dir to simulate an in-flight dispatch.
async function seedRunningJob(externalId: string): Promise<string> {
  const jobId = randomUUID();
  const job = {
    jobId,
    productSlug: PRODUCT_SLUG,
    externalId,
    specialistId: 'implementer',
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(testDir, 'data', 'jobs', `${jobId}.json`), JSON.stringify(job, null, 2));
  return jobId;
}

const validBody = { fromStage: 'in-development', toStage: 'plan-ready', reason: 'codex crash' };

// ── POST /api/items/:externalId/rollback ──────────────────────────────────────

describe('POST /api/items/:externalId/rollback', () => {
  it('rolls an in-development item back to plan-ready and records the history entry', async () => {
    await seedItemAt('HLM-1', 'in-development');

    const res = await post('/api/items/HLM-1/rollback', validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      externalId: string;
      currentStage: string;
      historyEntry: { fromStage: string; toStage: string; triggeredBy: string; note: string };
    };
    expect(body.externalId).toBe('HLM-1');
    expect(body.currentStage).toBe('plan-ready');
    expect(body.historyEntry.fromStage).toBe('in-development');
    expect(body.historyEntry.toStage).toBe('plan-ready');
    expect(body.historyEntry.triggeredBy).toBe('manual:rollback');
    expect(body.historyEntry.note).toBe('codex crash');

    // The store reflects the new state (not just the response).
    const list = await app.request('/api/items');
    const items = (await list.json()) as { externalId: string; currentStage: string }[];
    expect(items.find((i) => i.externalId === 'HLM-1')?.currentStage).toBe('plan-ready');
  });

  it('returns 400 when the item is not at fromStage (e.g. it is at code-review)', async () => {
    await seedItemAt('HLM-1', 'code-review');
    const res = await post('/api/items/HLM-1/rollback', validBody);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('code-review');
  });

  it('returns 400 for an unallowed pair (fromStage other than in-development)', async () => {
    await seedItemAt('HLM-1', 'code-review');
    const res = await post('/api/items/HLM-1/rollback', {
      fromStage: 'code-review',
      toStage: 'plan-ready',
      reason: 'nope',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unallowed toStage', async () => {
    await seedItemAt('HLM-1', 'in-development');
    const res = await post('/api/items/HLM-1/rollback', {
      fromStage: 'in-development',
      toStage: 'spec-draft',
      reason: 'nope',
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 with the runningJobId when a dispatch job is in flight', async () => {
    await seedItemAt('HLM-1', 'in-development');
    const jobId = await seedRunningJob('HLM-1');
    const res = await post('/api/items/HLM-1/rollback', validBody);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; runningJobId: string };
    expect(body.runningJobId).toBe(jobId);
  });

  it('returns 400 when reason is missing', async () => {
    await seedItemAt('HLM-1', 'in-development');
    const res = await post('/api/items/HLM-1/rollback', {
      fromStage: 'in-development',
      toStage: 'plan-ready',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when reason is an empty string', async () => {
    await seedItemAt('HLM-1', 'in-development');
    const res = await post('/api/items/HLM-1/rollback', { ...validBody, reason: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when reason exceeds 500 characters', async () => {
    await seedItemAt('HLM-1', 'in-development');
    const res = await post('/api/items/HLM-1/rollback', {
      ...validBody,
      reason: 'x'.repeat(501),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown body fields (strict schema)', async () => {
    await seedItemAt('HLM-1', 'in-development');
    const res = await post('/api/items/HLM-1/rollback', { ...validBody, extra: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid externalId', async () => {
    // '@' is outside EXTERNAL_ID_REGEX ([A-Za-z0-9._-]) but stays a single path
    // segment, so it reaches the handler and is rejected at the param check.
    const res = await post('/api/items/HLM@1/rollback', validBody);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the item does not exist', async () => {
    const res = await post('/api/items/HLM-999/rollback', validBody);
    expect(res.status).toBe(404);
  });
});
