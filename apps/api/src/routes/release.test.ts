import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';

// Mirrors rollback.test.ts: a minimal valid product config. The release endpoint
// resolves the product from here (single-product instance), not from the request.
// `workflow.final_stage` is omitted → defaults to 'released'.
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

// Opt-out variant: a product whose terminal stage is 'merged' (no released step).
const PRODUCT_YAML_MERGED_FINAL = PRODUCT_YAML.replace(
  'workflow:\n  stages_enabled: [in-development, released]',
  'workflow:\n  stages_enabled: [in-development, merged]\n  final_stage: merged',
);

let testDir: string;
let savedEnv: { dataDir: string | undefined; knowledgePath: string | undefined };

beforeEach(async () => {
  _resetForTests();
  testDir = join(tmpdir(), `helm-release-api-${randomUUID()}`);
  await mkdir(join(testDir, 'data', 'items'), { recursive: true });
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

// Swaps in a different product.yaml. Must be called before any request that loads
// config (getProductConfig caches; beforeEach reset the singleton).
async function useProduct(yaml: string): Promise<void> {
  await writeFile(join(testDir, 'knowledge', '.helm', 'product.yaml'), yaml);
}

// The valid forward chain up to `merged`. Seeding walks the transitions endpoint
// so the persisted history mirrors a real workflow.
const CHAIN = [
  'spec-draft',
  'spec-ready',
  'plan-draft',
  'plan-ready',
  'in-development',
  'code-review',
  'merged',
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

// ── POST /api/items/:externalId/release ───────────────────────────────────────

describe('POST /api/items/:externalId/release', () => {
  it('promotes a merged item to released and records the history entry', async () => {
    await seedItemAt('HLM-1', 'merged');

    const res = await post('/api/items/HLM-1/release', { reason: 'shipped in v1.2.0' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      externalId: string;
      currentStage: string;
      historyEntry: { fromStage: string; toStage: string; triggeredBy: string; note: string };
    };
    expect(body.externalId).toBe('HLM-1');
    expect(body.currentStage).toBe('released');
    expect(body.historyEntry.fromStage).toBe('merged');
    expect(body.historyEntry.toStage).toBe('released');
    expect(body.historyEntry.triggeredBy).toBe('manual:release');
    expect(body.historyEntry.note).toBe('shipped in v1.2.0');

    // The store reflects the new state (not just the response).
    const list = await app.request('/api/items');
    const items = (await list.json()) as { externalId: string; currentStage: string }[];
    expect(items.find((i) => i.externalId === 'HLM-1')?.currentStage).toBe('released');
  });

  it('succeeds without a reason (reason is optional)', async () => {
    await seedItemAt('HLM-1', 'merged');
    const res = await post('/api/items/HLM-1/release', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { historyEntry: { note?: string } };
    expect(body.historyEntry.note).toBeUndefined();
  });

  it('returns 400 when the item is not in merged (e.g. it is at code-review)', async () => {
    await seedItemAt('HLM-1', 'code-review');
    const res = await post('/api/items/HLM-1/release', { reason: 'too early' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // StageMismatchError message names the actual stage.
    expect(body.error).toContain('code-review');
    expect(body.error).toContain('merged');
  });

  it('returns 409 when the product opts out (workflow.final_stage = merged)', async () => {
    await useProduct(PRODUCT_YAML_MERGED_FINAL);
    await seedItemAt('HLM-1', 'merged');
    const res = await post('/api/items/HLM-1/release', { reason: 'no released stage' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('final_stage');
  });

  it('returns 400 when reason is an empty string', async () => {
    await seedItemAt('HLM-1', 'merged');
    const res = await post('/api/items/HLM-1/release', { reason: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when reason exceeds 500 characters', async () => {
    await seedItemAt('HLM-1', 'merged');
    const res = await post('/api/items/HLM-1/release', { reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown body fields (strict schema)', async () => {
    await seedItemAt('HLM-1', 'merged');
    const res = await post('/api/items/HLM-1/release', { reason: 'ok', extra: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid externalId', async () => {
    const res = await post('/api/items/HLM@1/release', { reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the item does not exist', async () => {
    const res = await post('/api/items/HLM-999/release', { reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 400 on a malformed JSON body', async () => {
    const res = await app.request('/api/items/HLM-1/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 500 with a generic message when product config cannot be loaded', async () => {
    delete process.env.HELM_KNOWLEDGE_REPO_PATH;
    const res = await post('/api/items/HLM-1/release', { reason: 'x' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to load product config');
  });

  // ── Grandfather (ADR-032): no migration, forward-only ─────────────────────
  // An item that is already 'released' must stay 'released' and not be
  // re-processable — there is no reclassification of pre-H5 items to 'merged'.
  it('leaves an already-released item untouched (no re-release, stage preserved)', async () => {
    await seedItemAt('HLM-1', 'merged');
    // Promote once: merged → released.
    expect((await post('/api/items/HLM-1/release', {})).status).toBe(200);

    // A second release is rejected (item not in 'merged' → 400) and the stage
    // is unchanged — the released item is left exactly as-is.
    const second = await post('/api/items/HLM-1/release', { reason: 'again' });
    expect(second.status).toBe(400);

    const list = await app.request('/api/items');
    const items = (await list.json()) as {
      externalId: string;
      currentStage: string;
      history: unknown[];
    }[];
    const item = items.find((i) => i.externalId === 'HLM-1');
    expect(item?.currentStage).toBe('released');
    // No extra history entry was appended by the rejected second release.
    expect(
      item?.history.filter((h) => (h as { toStage: string }).toStage === 'released'),
    ).toHaveLength(1);
  });
});
