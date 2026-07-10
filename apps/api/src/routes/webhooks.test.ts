import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import {
  _resetForTests,
  getGitHubAdapter,
  getIssueTrackerAdapter,
  getProductConfig,
} from '../services/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockParseWebhook,
  mockCreate,
  mockTransition,
  mockList,
  mockGet,
  mockSetSubStage,
  mockEnsureSubStages,
  mockScheduleItemDispatch,
} = vi.hoisted(() => ({
  mockParseWebhook: vi.fn(),
  mockCreate: vi.fn(),
  mockTransition: vi.fn(),
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockSetSubStage: vi.fn(),
  mockEnsureSubStages: vi.fn(),
  mockScheduleItemDispatch: vi.fn(),
}));

vi.mock('../services/dispatch-scheduler.js', () => ({
  scheduleItemDispatch: mockScheduleItemDispatch,
}));

vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getGitHubAdapter: vi.fn().mockResolvedValue({ parseWebhook: mockParseWebhook }),
    // Writeback (ADR-033) resolves the tracker adapter through this accessor.
    getIssueTrackerAdapter: vi
      .fn()
      .mockResolvedValue({ setSubStage: mockSetSubStage, ensureSubStages: mockEnsureSubStages }),
    getItemStore: vi.fn().mockResolvedValue({
      create: mockCreate,
      transition: mockTransition,
      list: mockList,
      get: mockGet,
    }),
    getProductConfig: vi.fn().mockResolvedValue({
      product: { slug: 'test-app', name: 'Test' },
      issue_tracker: {
        provider: 'github_projects',
        org: 'test-org',
        project_number: 1,
        custom_field_name: 'Helm Stage',
      },
      workflow: { final_stage: 'released' },
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', TEST_SECRET).update(body).digest('hex');
}

async function post(
  body: string,
  eventType = 'issues',
  overrideSig?: string | null,
): Promise<Response> {
  const sig = overrideSig === null ? undefined : (overrideSig ?? sign(body));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': eventType,
    'x-github-delivery': 'abc-123',
  };
  if (sig !== undefined) headers['x-hub-signature-256'] = sig;
  return app.request('/api/webhooks/github', { method: 'POST', headers, body });
}

/** Builds a real pull_request webhook payload (parsed by the pure parseGitHubWebhook). */
function mergedPrPayload(
  headRef: string,
  opts: { action?: string; merged?: boolean; senderLogin?: string } = {},
): string {
  const payload: Record<string, unknown> = {
    action: opts.action ?? 'closed',
    pull_request: { merged: opts.merged ?? true, head: { ref: headRef } },
  };
  if (opts.senderLogin) {
    payload.sender = { login: opts.senderLogin };
  }
  return JSON.stringify(payload);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/github', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    // clearAllMocks does not reset implementations, so a per-describe override
    // (e.g. the Linear block) would otherwise leak into later tests. Re-establish
    // the default GitHub Projects config and a working adapter before each test.
    vi.mocked(getProductConfig).mockResolvedValue({
      product: { slug: 'test-app', name: 'Test' },
      issue_tracker: {
        provider: 'github_projects',
        org: 'test-org',
        project_number: 1,
        custom_field_name: 'Helm Stage',
      },
      workflow: { final_stage: 'released' },
    } as never);
    vi.mocked(getGitHubAdapter).mockResolvedValue({ parseWebhook: mockParseWebhook } as never);
    // Writeback adapter stub (ADR-033): ensureSubStages + setSubStage resolve so
    // a successful writeback can be asserted; clearAllMocks wiped the impls.
    mockEnsureSubStages.mockResolvedValue(undefined);
    mockSetSubStage.mockResolvedValue(undefined);
    mockScheduleItemDispatch.mockResolvedValue({ scheduled: true, jobId: 'job-sync-1' });
    mockGet.mockResolvedValue(null);
    vi.mocked(getIssueTrackerAdapter).mockResolvedValue({
      setSubStage: mockSetSubStage,
      ensureSubStages: mockEnsureSubStages,
    } as never);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  describe('authentication', () => {
    it('returns 503 when GITHUB_WEBHOOK_SECRET is not set', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const res = await post('{}');
      expect(res.status).toBe(503);
    });

    it('returns 401 when signature is missing', async () => {
      const res = await post('{}', 'issues', null);
      expect(res.status).toBe(401);
    });

    it('returns 401 when signature is invalid', async () => {
      const res = await post(
        '{}',
        'issues',
        'sha256=deadbeef00000000000000000000000000000000000000000000000000000000',
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 when body is not valid JSON (but signature is valid)', async () => {
      const body = 'not-json';
      const res = await post(body, 'issues', sign(body));
      expect(res.status).toBe(400);
    });
  });

  describe('dispatch: item_created', () => {
    it('calls itemStore.create and returns 200', async () => {
      const body = JSON.stringify({ action: 'opened', issue: { number: 42 } });
      mockParseWebhook.mockReturnValue({
        type: 'item_created',
        externalId: 'issue_42',
        timestamp: 't',
      });
      mockCreate.mockResolvedValue({ history: [] });

      const res = await post(body);

      expect(res.status).toBe(200);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          productSlug: 'test-app',
          triggeredBy: 'webhook:github-projects',
        }),
      );
    });

    it('returns 200 when item already exists (idempotent)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_created',
        externalId: 'issue_1',
        timestamp: 't',
      });
      const { ItemAlreadyExistsError } = await import('../services/errors.js');
      mockCreate.mockRejectedValue(new ItemAlreadyExistsError('issue_1'));

      const res = await post(body);
      expect(res.status).toBe(200);
    });
  });

  describe('dispatch: item_updated with subStage', () => {
    it('calls itemStore.transition and returns 200', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'issue_5',
        subStage: 'spec-ready',
        timestamp: 't',
      });
      mockTransition.mockResolvedValue({ history: [] });

      const res = await post(body, 'projects_v2_item');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'issue_5', toStage: 'spec-ready' }),
      );
      // Anti-echo (ADR-033): this transition is tracker-originated
      // (webhook:github-projects), so it must NOT be written back — otherwise it
      // would loop tracker → store → tracker.
      expect(mockSetSubStage).not.toHaveBeenCalled();
    });

    it('returns 200 on WorkflowTransitionError (not a delivery problem)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'issue_5',
        subStage: 'released',
        timestamp: 't',
      });
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Invalid transition', 'discovery', 'released'),
      );

      const res = await post(body, 'projects_v2_item');
      expect(res.status).toBe(200);
    });

    it('returns 200 on ItemNotFoundError (not a delivery problem)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'issue_99',
        subStage: 'spec-ready',
        timestamp: 't',
      });
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('issue_99'));

      const res = await post(body, 'projects_v2_item');
      expect(res.status).toBe(200);
    });
  });

  describe('dispatch: other event types', () => {
    it('returns 200 for comment_added without calling create or transition', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'comment_added',
        externalId: 'issue_1',
        body: 'hi',
        timestamp: 't',
      });

      const res = await post(body, 'issue_comment');
      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 for unknown event type without dispatch', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({ type: 'unknown', raw: {} });

      const res = await post(body, 'push');
      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('returns 200 for item_updated with only status (no subStage — no workflow action)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'issue_3',
        status: 'closed',
        timestamp: 't',
      });

      const res = await post(body, 'issues');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });
  });

  describe('dispatch: pull_request_merged', () => {
    // Fix 1: pull_request events are parsed by the pure parseGitHubWebhook — the
    // GitHub Projects adapter is NOT consulted. Each test sends a real PR payload.

    // ── Spec merge (helm/spec/ → spec-ready) ────────────────────────────────

    it('transitions spec-draft → spec-ready when helm/spec/ branch is merged', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      // Writeback reads the resulting ItemState, so the mock returns a realistic one.
      mockTransition.mockResolvedValue({
        externalId: 'issue_42',
        currentStage: 'spec-ready',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'spec-ready',
        triggeredBy: 'webhook:knowledge-repo',
      });
      // Fix 1: the GitHub Projects adapter is never consulted for pull_request events.
      expect(getGitHubAdapter).not.toHaveBeenCalled();
      // Writeback (ADR-033): webhook:knowledge-repo is NOT tracker-originated, so
      // the new stage IS pushed back to the tracker.
      expect(mockSetSubStage).toHaveBeenCalledWith('issue_42', 'spec-ready');
    });

    it('returns 200 on WorkflowTransitionError for spec merge (item already past spec-draft)', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Cannot transition', 'spec-ready', 'spec-ready'),
      );

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledOnce();
    });

    it('returns 200 on ItemNotFoundError for spec merge (item not in this Helm instance)', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('issue_42'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during spec merge transition', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Plan merge (helm/plan/ → plan-ready) ─────────────────────────────────

    it('transitions plan-draft → plan-ready when helm/plan/ branch is merged', async () => {
      const body = mergedPrPayload('helm/plan/issue_42');
      mockTransition.mockResolvedValue({ history: [] });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'plan-ready',
        triggeredBy: 'webhook:knowledge-repo',
      });
    });

    it('returns 200 on WorkflowTransitionError for plan merge (item already past plan-draft)', async () => {
      const body = mergedPrPayload('helm/plan/issue_42');
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Cannot transition', 'plan-ready', 'plan-ready'),
      );

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledOnce();
    });

    it('returns 200 on ItemNotFoundError for plan merge (item not in this Helm instance)', async () => {
      const body = mergedPrPayload('helm/plan/HLM-7');
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('HLM-7'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during plan merge transition', async () => {
      const body = mergedPrPayload('helm/plan/issue_42');
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Impl merge (helm/impl/ → merged) ────────────────────────────────────
    // ADR-032: the impl PR merge now lands the item in `merged`, NOT `released`.
    // `released` is reached only via the release trigger (endpoint / webhook).

    it('transitions code-review → merged when helm/impl/ branch is merged', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockTransition.mockResolvedValue({ history: [] });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'merged',
        triggeredBy: 'webhook:code-repo',
      });
    });

    it('returns 200 on WorkflowTransitionError for impl merge (item already past code-review)', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Cannot transition', 'merged', 'merged'),
      );

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledOnce();
    });

    it('returns 200 on ItemNotFoundError for impl merge (item not in this Helm instance)', async () => {
      const body = mergedPrPayload('helm/impl/HLM-7');
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('HLM-7'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during impl merge transition', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Impl PR synchronize (helm/impl/ → re-dispatch reviewer-fanout) ─────

    it('schedules reviewer-fanout when helm/impl/ PR syncs and item is in code-review', async () => {
      const body = mergedPrPayload('helm/impl/LEA-192', { action: 'synchronize', merged: false });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'LEA-192',
        triggeredBy: 'webhook:impl-pr-sync',
      });
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('skips dispatch when impl PR syncs but item is not in code-review', async () => {
      const body = mergedPrPayload('helm/impl/LEA-192', { action: 'synchronize', merged: false });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'remediation',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores synchronize on non-impl branches', async () => {
      const body = mergedPrPayload('feature/foo', { action: 'synchronize', merged: false });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores synchronize when push is from helm-bot (orchestrator remediation)', async () => {
      const body = mergedPrPayload('helm/impl/LEA-192', {
        action: 'synchronize',
        merged: false,
        senderLogin: 'helm-bot',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('returns 200 when impl PR sync dispatch throws (avoids GitHub webhook retries)', async () => {
      const body = mergedPrPayload('helm/impl/LEA-192', { action: 'synchronize', merged: false });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockScheduleItemDispatch.mockRejectedValue(new Error('scheduler unavailable'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    // ── Non-actionable PR actions ─────────────────────────────────────────────

    it('returns 200 without transition when PR is closed but not merged', async () => {
      const body = mergedPrPayload('helm/spec/issue_42', { merged: false });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    // ── Non-artifact branches ─────────────────────────────────────────────────

    it('returns 200 without transition when branch is not an artifact branch', async () => {
      const body = mergedPrPayload('feature/some-feature');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal headRef (parseArtifactBranch rejects it)', async () => {
      const body = mergedPrPayload('helm/spec/../etc/passwd');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal plan headRef', async () => {
      const body = mergedPrPayload('helm/plan/../etc/passwd');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal impl headRef', async () => {
      const body = mergedPrPayload('helm/impl/../etc/passwd');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });
  });

  // ── ADR-032: release.published bulk-promotes merged → released ─────────────

  describe('dispatch: release_published', () => {
    /** Builds a real GitHub release webhook payload (parsed by parseGitHubWebhook). */
    function releasePayload(opts: { action?: string; tag?: string } = {}): string {
      return JSON.stringify({
        action: opts.action ?? 'published',
        release: { tag_name: opts.tag ?? 'v1.2.0' },
      });
    }

    it('promotes every merged item to released and returns 200', async () => {
      mockList.mockResolvedValue([
        { externalId: 'issue_1', currentStage: 'merged' },
        { externalId: 'issue_2', currentStage: 'code-review' }, // not merged — skipped
        { externalId: 'issue_3', currentStage: 'merged' },
        { externalId: 'issue_4', currentStage: 'released' }, // already released — skipped
      ]);
      mockTransition.mockResolvedValue({ history: [] });

      const res = await post(releasePayload(), 'release');

      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledTimes(2);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_1',
        toStage: 'released',
        triggeredBy: 'webhook:release',
      });
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_3',
        toStage: 'released',
        triggeredBy: 'webhook:release',
      });
      // Not consulted for repo-level events (parsed by the pure parser).
      expect(getGitHubAdapter).not.toHaveBeenCalled();
    });

    it('is a no-op for a product with final_stage=merged', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'playground', name: 'Playground' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        workflow: { final_stage: 'merged' },
      } as never);

      const res = await post(releasePayload(), 'release');

      expect(res.status).toBe(200);
      expect(mockList).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('ignores a non-published release action (e.g. created)', async () => {
      const res = await post(releasePayload({ action: 'created' }), 'release');

      expect(res.status).toBe(200);
      expect(mockList).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('continues promoting after a per-item error and still returns 200', async () => {
      mockList.mockResolvedValue([
        { externalId: 'issue_1', currentStage: 'merged' },
        { externalId: 'issue_2', currentStage: 'merged' },
      ]);
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition
        .mockRejectedValueOnce(new ItemNotFoundError('issue_1')) // vanished between list and transition
        .mockResolvedValueOnce({ history: [] });

      const res = await post(releasePayload(), 'release');

      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledTimes(2);
    });

    it('returns 500 on an unexpected (non-workflow) error during promotion', async () => {
      mockList.mockResolvedValue([{ externalId: 'issue_1', currentStage: 'merged' }]);
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(releasePayload(), 'release');
      expect(res.status).toBe(500);
    });

    it('returns 500 with controlled logging when a pre-loop call throws (itemStore.list)', async () => {
      // list() runs before the per-item guard; the branch-level try-catch must
      // turn the throw into a clean 500, not let it escape to the default handler.
      mockList.mockRejectedValue(new Error('store unavailable'));

      const res = await post(releasePayload(), 'release');
      expect(res.status).toBe(500);
      expect(mockTransition).not.toHaveBeenCalled();
    });
  });

  // ── Fix 1: Linear products (knowledge/code repos are still GitHub) ──────────

  describe('Linear product: tracker-agnostic pull_request routing', () => {
    beforeEach(() => {
      // A Linear product's getGitHubAdapter() throws — its config doesn't match
      // the GitHub Projects schema. The route must not call it for PR events.
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'mome', name: 'MOME' },
        issue_tracker: {
          provider: 'linear',
          webhook_secret_env: 'LINEAR_WEBHOOK_SECRET',
        },
      } as never);
      vi.mocked(getGitHubAdapter).mockRejectedValue(
        new Error('GitHub Projects adapter is not available for a linear product'),
      );
    });

    it('processes a pull_request_merged for a Linear product without the GitHub adapter', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockTransition.mockResolvedValue({ history: [] });

      const res = await post(body, 'pull_request');

      expect(res.status).toBe(200);
      expect(getGitHubAdapter).not.toHaveBeenCalled();
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'merged',
        triggeredBy: 'webhook:code-repo',
      });
    });

    it('an issues event is rejected with a controlled 400 for a Linear product (issues arrive via /linear)', async () => {
      const body = JSON.stringify({ action: 'opened', issue: { number: 1, node_id: 'I_1' } });

      const res = await post(body, 'issues');

      // The provider mismatch is detected up front → explicit 400 (not an opaque
      // framework 500) so GitHub does not retry a misrouted delivery. The adapter
      // is never consulted — genuine adapter/token faults are reserved for 500.
      expect(res.status).toBe(400);
      expect(getGitHubAdapter).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── Genuine server-side adapter faults must NOT be masked as 400 ────────────

  describe('GitHub Projects product: adapter faults surface as 500 (delivery retried)', () => {
    it('returns 500 when the adapter fails for a correctly-routed issues event (e.g. missing token)', async () => {
      // Provider IS github_projects (default config), so the route proceeds to the
      // adapter — a genuine fault here must stay 500 so GitHub retries the delivery,
      // not be collapsed into the provider-mismatch 400.
      vi.mocked(getGitHubAdapter).mockRejectedValue(
        new Error('GITHUB_TOKEN environment variable is not set or blank'),
      );
      const body = JSON.stringify({ action: 'opened', issue: { number: 7, node_id: 'I_7' } });

      const res = await post(body, 'issues');

      expect(res.status).toBe(500);
      expect(getGitHubAdapter).toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
