import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';
import { GitHubPullRequestLookupError } from '../services/github-pull-requests.js';

// Stub the tracker adapter so writeback (ADR-033) is deterministic and never
// touches the network — getProductConfig/getItemStore stay real (filesystem).
// NOTE: the spies live in this file's own vi.hoisted block (not a shared helper)
// because a vi.mock factory cannot reference an imported value — vitest hoists
// the factory above imports, so a shared mock would throw "Cannot access before
// initialization". The duplication across items/release/rollback is required.
const { mockSetSubStage, mockEnsureSubStages, mockResolveCurrentPullRequestState } = vi.hoisted(
  () => ({
    mockSetSubStage: vi.fn().mockResolvedValue(undefined),
    mockEnsureSubStages: vi.fn().mockResolvedValue(undefined),
    mockResolveCurrentPullRequestState: vi.fn(),
  }),
);
vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getIssueTrackerAdapter: vi
      .fn()
      .mockResolvedValue({ setSubStage: mockSetSubStage, ensureSubStages: mockEnsureSubStages }),
  };
});
vi.mock('../services/github-pull-requests.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/github-pull-requests.js')>();
  return {
    ...real,
    resolveCurrentPullRequestState: mockResolveCurrentPullRequestState,
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
let savedEnv: {
  dataDir: string | undefined;
  knowledgePath: string | undefined;
  githubToken: string | undefined;
};

beforeEach(async () => {
  _resetForTests();
  // Isolate the writeback spies between tests (this suite uses _resetForTests,
  // not clearAllMocks, so the hoisted mocks would otherwise accumulate calls).
  mockSetSubStage.mockClear();
  mockEnsureSubStages.mockClear();
  mockResolveCurrentPullRequestState.mockReset();
  testDir = join(tmpdir(), `helm-items-api-${randomUUID()}`);
  await mkdir(join(testDir, 'data'), { recursive: true });
  await mkdir(join(testDir, 'knowledge', '.helm'), { recursive: true });
  await writeFile(join(testDir, 'knowledge', '.helm', 'product.yaml'), PRODUCT_YAML);

  savedEnv = {
    dataDir: process.env.HELM_DATA_DIR,
    knowledgePath: process.env.HELM_KNOWLEDGE_REPO_PATH,
    githubToken: process.env.GITHUB_TOKEN,
  };
  process.env.HELM_DATA_DIR = join(testDir, 'data');
  process.env.HELM_KNOWLEDGE_REPO_PATH = join(testDir, 'knowledge');
  process.env.GITHUB_TOKEN = 'test-github-token';
});

afterEach(async () => {
  _resetForTests();
  await rm(testDir, { recursive: true, force: true });
  if (savedEnv.dataDir === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = savedEnv.dataDir;
  if (savedEnv.knowledgePath === undefined) delete process.env.HELM_KNOWLEDGE_REPO_PATH;
  else process.env.HELM_KNOWLEDGE_REPO_PATH = savedEnv.knowledgePath;
  if (savedEnv.githubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedEnv.githubToken;
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

// ── POST /api/items/:externalId/merge-reconciliation ─────────────────────────

describe('POST /api/items/:externalId/merge-reconciliation', () => {
  async function seedSpecDraftItem(): Promise<void> {
    await post('/api/items', { externalId: 'HLM-1', triggeredBy: 'human:test' });
    await post('/api/items/HLM-1/transitions', {
      toStage: 'spec-draft',
      triggeredBy: 'test:advance',
    });
    mockSetSubStage.mockClear();
  }

  async function seedCodeReviewItem(): Promise<void> {
    await post('/api/items', { externalId: 'HLM-1', triggeredBy: 'human:test' });
    for (const toStage of [
      'spec-draft',
      'spec-ready',
      'plan-draft',
      'plan-ready',
      'in-development',
      'code-review',
    ] as const) {
      await post('/api/items/HLM-1/transitions', { toStage, triggeredBy: 'test:advance' });
    }
    mockSetSubStage.mockClear();
  }

  beforeEach(() => {
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestId: 5001,
      pullRequestNumber: 7,
      headRef: 'helm/impl/HLM-1',
      headSha: 'sha-1',
      merged: true,
      mergedAt: '2026-07-21T12:00:00Z',
      htmlUrl: 'https://github.com/example-org/example-app/pull/7',
    });
  });

  it('reconciles a merged artifact PR from current GitHub state', async () => {
    await seedCodeReviewItem();

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; toStage: string };
    expect(body.status).toBe('advanced');
    expect(body.toStage).toBe('merged');
    expect(mockSetSubStage).toHaveBeenCalledWith('HLM-1', 'merged');
  });

  it('ignores merged PR state from repositories outside the product allowlist', async () => {
    await seedCodeReviewItem();
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'outside-org', repo: 'outside-app' },
      pullRequestId: 5001,
      pullRequestNumber: 7,
      headRef: 'helm/impl/HLM-1',
      headSha: 'sha-1',
      merged: true,
      mergedAt: '2026-07-21T12:00:00Z',
      htmlUrl: 'https://github.com/outside-org/outside-app/pull/7',
    });

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'outside-org', repo: 'outside-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ignored',
      reason: 'repository-not-allowed',
      externalId: 'HLM-1',
    });
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('ignores spec and plan PR state from repositories outside the knowledge repo', async () => {
    await seedSpecDraftItem();
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestId: 5002,
      pullRequestNumber: 8,
      headRef: 'helm/spec/HLM-1',
      headSha: 'sha-2',
      merged: true,
      mergedAt: '2026-07-21T12:00:00Z',
      htmlUrl: 'https://github.com/example-org/example-app/pull/8',
    });

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 8,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ignored',
      reason: 'repository-not-allowed',
      externalId: 'HLM-1',
    });
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('is a no-op when the same recovery call is repeated after success', async () => {
    await seedCodeReviewItem();
    await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });
    const afterFirst = (await (await app.request('/api/items')).json()) as Array<{
      externalId: string;
      history: unknown[];
    }>;
    mockSetSubStage.mockClear();

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });
    const afterSecond = (await (await app.request('/api/items')).json()) as Array<{
      externalId: string;
      history: unknown[];
    }>;

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('already-reconciled');
    expect(afterSecond[0]?.history).toHaveLength(afterFirst[0]?.history.length ?? 0);
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('returns 404 when GitHub reports the pull request does not exist', async () => {
    mockResolveCurrentPullRequestState.mockRejectedValue(
      new GitHubPullRequestLookupError('Pull request not found', {
        code: 'not_found',
        githubStatus: 404,
      }),
    );

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Pull request not found',
      code: 'not_found',
    });
  });

  it('returns 503 when GitHub rate limits the lookup', async () => {
    mockResolveCurrentPullRequestState.mockRejectedValue(
      new GitHubPullRequestLookupError('GitHub API rate limit exceeded', {
        code: 'rate_limited',
        githubStatus: 403,
      }),
    );

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'GitHub rate limit exceeded',
      code: 'rate_limited',
    });
  });

  it('returns 504 when the GitHub lookup times out', async () => {
    mockResolveCurrentPullRequestState.mockRejectedValue(
      new GitHubPullRequestLookupError('GitHub API request timed out', { code: 'timeout' }),
    );

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: 'GitHub pull request lookup timed out',
      code: 'timeout',
    });
  });
});
