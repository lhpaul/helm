import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
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
  webhookSecret: string | undefined;
};

const TEST_WEBHOOK_SECRET = 'test-items-webhook-secret';

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
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  };
  process.env.HELM_DATA_DIR = join(testDir, 'data');
  process.env.HELM_KNOWLEDGE_REPO_PATH = join(testDir, 'knowledge');
  process.env.GITHUB_TOKEN = 'test-github-token';
  process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
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
  if (savedEnv.webhookSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = savedEnv.webhookSecret;
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
  async function seedAt(
    externalId: string,
    stage:
      | 'spec-draft'
      | 'plan-draft'
      | 'code-review'
      | 'spec-ready'
      | 'plan-ready'
      | 'in-development'
      | 'merged',
  ): Promise<void> {
    await post('/api/items', { externalId, triggeredBy: 'human:test' });
    const chain = [
      'spec-draft',
      'spec-ready',
      'plan-draft',
      'plan-ready',
      'in-development',
      'code-review',
      'merged',
    ] as const;
    for (const toStage of chain) {
      const items = (await (await app.request('/api/items')).json()) as Array<{
        externalId: string;
        currentStage: string;
      }>;
      if (items.find((item) => item.externalId === externalId)?.currentStage === stage) break;
      await post(`/api/items/${externalId}/transitions`, { toStage, triggeredBy: 'test:advance' });
    }
    mockSetSubStage.mockClear();
  }

  async function seedSpecDraftItem(): Promise<void> {
    await seedAt('HLM-1', 'spec-draft');
  }

  async function seedCodeReviewItem(): Promise<void> {
    await seedAt('HLM-1', 'code-review');
  }

  function signWebhook(body: string): string {
    return 'sha256=' + createHmac('sha256', TEST_WEBHOOK_SECRET).update(body).digest('hex');
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

  it.each([
    {
      kind: 'impl',
      seed: 'code-review' as const,
      headRef: 'helm/impl/HLM-1',
      repo: { owner: 'example-org', repo: 'example-app' },
      toStage: 'merged',
      pullRequestId: 5001,
      pullRequestNumber: 7,
    },
    {
      kind: 'spec',
      seed: 'spec-draft' as const,
      headRef: 'helm/spec/HLM-1',
      repo: { owner: 'example-org', repo: 'example-app-knowledge' },
      toStage: 'spec-ready',
      pullRequestId: 5002,
      pullRequestNumber: 8,
    },
    {
      kind: 'plan',
      seed: 'plan-draft' as const,
      headRef: 'helm/plan/HLM-1',
      repo: { owner: 'example-org', repo: 'example-app-knowledge' },
      toStage: 'plan-ready',
      pullRequestId: 5003,
      pullRequestNumber: 9,
    },
  ])(
    'reconciles a merged $kind artifact PR from current GitHub state',
    async ({ seed, headRef, repo, toStage, pullRequestId, pullRequestNumber }) => {
      await seedAt('HLM-1', seed);
      mockResolveCurrentPullRequestState.mockResolvedValue({
        repository: repo,
        pullRequestId,
        pullRequestNumber,
        headRef,
        headSha: 'sha-1',
        merged: true,
        mergedAt: '2026-07-21T12:00:00Z',
        htmlUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${pullRequestNumber}`,
      });

      const res = await post('/api/items/HLM-1/merge-reconciliation', {
        repository: repo,
        pullRequestNumber,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; toStage: string };
      expect(body.status).toBe('advanced');
      expect(body.toStage).toBe(toStage);
      expect(mockSetSubStage).toHaveBeenCalledWith('HLM-1', toStage);
    },
  );

  it('serializes webhook and recovery overlap through the real HTTP entrypoints', async () => {
    await seedCodeReviewItem();
    const pullRequestId = 5001;
    const pullRequestNumber = 7;
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestId,
      pullRequestNumber,
      headRef: 'helm/impl/HLM-1',
      headSha: 'sha-1',
      merged: true,
      mergedAt: '2026-07-21T12:00:00Z',
      htmlUrl: 'https://github.com/example-org/example-app/pull/7',
    });

    const webhookBody = JSON.stringify({
      action: 'closed',
      pull_request: {
        id: pullRequestId,
        number: pullRequestNumber,
        merged: true,
        head: { ref: 'helm/impl/HLM-1', sha: 'sha-1' },
      },
      repository: {
        name: 'example-app',
        owner: { login: 'example-org' },
      },
    });

    const [webhookRes, recoveryRes] = await Promise.all([
      app.request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'overlap-1',
          'x-hub-signature-256': signWebhook(webhookBody),
        },
        body: webhookBody,
      }),
      post('/api/items/HLM-1/merge-reconciliation', {
        repository: { owner: 'example-org', repo: 'example-app' },
        pullRequestNumber,
      }),
    ]);

    expect(webhookRes.status).toBe(200);
    expect(recoveryRes.status).toBe(200);
    const recoveryBody = (await recoveryRes.json()) as { status: string };
    expect(['advanced', 'already-reconciled']).toContain(recoveryBody.status);

    const items = (await (await app.request('/api/items')).json()) as Array<{
      externalId: string;
      currentStage: string;
      history: Array<{ idempotencyKey?: string }>;
    }>;
    const item = items.find((entry) => entry.externalId === 'HLM-1');
    const mergeEvents =
      item?.history.filter(
        (event) =>
          event.idempotencyKey === 'merge-reconciliation:example-org/example-app#id:5001:merged',
      ) ?? [];

    expect(item?.currentStage).toBe('merged');
    expect(mergeEvents).toHaveLength(1);
    expect(mockSetSubStage).toHaveBeenCalledWith('HLM-1', 'merged');
    expect(mockSetSubStage).toHaveBeenCalledTimes(1);
  });

  it('ignores recovery when the PR head belongs to a different item', async () => {
    await seedCodeReviewItem();
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestId: 5001,
      pullRequestNumber: 7,
      headRef: 'helm/impl/HLM-2',
      headSha: 'sha-1',
      merged: true,
      mergedAt: '2026-07-21T12:00:00Z',
      htmlUrl: 'https://github.com/example-org/example-app/pull/7',
    });
    const before = (await (await app.request('/api/items')).json()) as Array<{
      history: unknown[];
    }>;

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ignored',
      reason: 'external-id-mismatch',
      externalId: 'HLM-2',
    });
    const after = (await (await app.request('/api/items')).json()) as Array<{
      history: unknown[];
    }>;
    expect(after[0]?.history).toHaveLength(before[0]?.history.length ?? 0);
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('ignores recovery when GitHub reports the PR is not merged', async () => {
    await seedCodeReviewItem();
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestId: 5001,
      pullRequestNumber: 7,
      headRef: 'helm/impl/HLM-1',
      headSha: 'sha-1',
      merged: false,
      mergedAt: null,
      htmlUrl: 'https://github.com/example-org/example-app/pull/7',
    });

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'not-merged' });
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('ignores recovery when the PR head is not an artifact branch', async () => {
    await seedCodeReviewItem();
    mockResolveCurrentPullRequestState.mockResolvedValue({
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestId: 5001,
      pullRequestNumber: 7,
      headRef: 'feature/random',
      headSha: 'sha-1',
      merged: true,
      mergedAt: '2026-07-21T12:00:00Z',
      htmlUrl: 'https://github.com/example-org/example-app/pull/7',
    });

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ignored',
      reason: 'unsupported-artifact-branch',
    });
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('rejects recovery for repositories outside the product allowlist before GitHub lookup', async () => {
    await seedCodeReviewItem();

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'outside-org', repo: 'outside-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Repository is not configured for this product',
      code: 'repository_not_allowed',
    });
    expect(mockResolveCurrentPullRequestState).not.toHaveBeenCalled();
    expect(mockSetSubStage).not.toHaveBeenCalled();
  });

  it('rejects "." and ".." repository segments without calling GitHub', async () => {
    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: '..', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(400);
    expect(mockResolveCurrentPullRequestState).not.toHaveBeenCalled();
  });

  it('returns 503 with a sanitized message when GitHub credentials are missing', async () => {
    delete process.env.GITHUB_TOKEN;

    const res = await post('/api/items/HLM-1/merge-reconciliation', {
      repository: { owner: 'example-org', repo: 'example-app' },
      pullRequestNumber: 7,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'GitHub credentials are not configured' });
    expect(mockResolveCurrentPullRequestState).not.toHaveBeenCalled();
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
