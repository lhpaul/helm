import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockParseWebhook, mockCreate, mockTransition } = vi.hoisted(() => ({
  mockParseWebhook: vi.fn(),
  mockCreate: vi.fn(),
  mockTransition: vi.fn(),
}));

vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getGitHubAdapter: vi.fn().mockResolvedValue({ parseWebhook: mockParseWebhook }),
    getItemStore: vi.fn().mockResolvedValue({ create: mockCreate, transition: mockTransition }),
    getProductConfig: vi.fn().mockResolvedValue({
      product: { slug: 'test-app', name: 'Test' },
      issue_tracker: {
        provider: 'github_projects',
        org: 'test-org',
        project_number: 1,
        custom_field_name: 'Helm Stage',
      },
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/github', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
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
      mockCreate.mockResolvedValue({});

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
      mockTransition.mockResolvedValue({});

      const res = await post(body, 'projects_v2_item');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'issue_5', toStage: 'spec-ready' }),
      );
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
    // ── Spec merge (helm/spec/ → spec-ready) ────────────────────────────────

    it('transitions spec-draft → spec-ready when helm/spec/ branch is merged', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/spec/issue_42',
        timestamp: 't',
      });
      mockTransition.mockResolvedValue({});

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'spec-ready',
        triggeredBy: 'webhook:knowledge-repo',
      });
    });

    it('returns 200 on WorkflowTransitionError for spec merge (item already past spec-draft)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/spec/issue_42',
        timestamp: 't',
      });
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Cannot transition', 'spec-ready', 'spec-ready'),
      );

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledOnce();
    });

    it('returns 200 on ItemNotFoundError for spec merge (item not in this Helm instance)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/spec/issue_42',
        timestamp: 't',
      });
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('issue_42'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during spec merge transition', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/spec/issue_42',
        timestamp: 't',
      });
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Plan merge (helm/plan/ → plan-ready) ─────────────────────────────────

    it('transitions plan-draft → plan-ready when helm/plan/ branch is merged', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/plan/issue_42',
        timestamp: 't',
      });
      mockTransition.mockResolvedValue({});

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'plan-ready',
        triggeredBy: 'webhook:knowledge-repo',
      });
    });

    it('returns 200 on WorkflowTransitionError for plan merge (item already past plan-draft)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/plan/issue_42',
        timestamp: 't',
      });
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Cannot transition', 'plan-ready', 'plan-ready'),
      );

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledOnce();
    });

    it('returns 200 on ItemNotFoundError for plan merge (item not in this Helm instance)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/plan/HLM-7',
        timestamp: 't',
      });
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('HLM-7'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during plan merge transition', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/plan/issue_42',
        timestamp: 't',
      });
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Impl merge (helm/impl/ → released) ──────────────────────────────────

    it('transitions code-review → released when helm/impl/ branch is merged', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/impl/issue_42',
        timestamp: 't',
      });
      mockTransition.mockResolvedValue({});

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith({
        externalId: 'issue_42',
        toStage: 'released',
        triggeredBy: 'webhook:code-repo',
      });
    });

    it('returns 200 on WorkflowTransitionError for impl merge (item already past code-review)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/impl/issue_42',
        timestamp: 't',
      });
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Cannot transition', 'code-review', 'released'),
      );

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledOnce();
    });

    it('returns 200 on ItemNotFoundError for impl merge (item not in this Helm instance)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/impl/HLM-7',
        timestamp: 't',
      });
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('HLM-7'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during impl merge transition', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/impl/issue_42',
        timestamp: 't',
      });
      mockTransition.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Non-artifact branches ─────────────────────────────────────────────────

    it('returns 200 without transition when branch is not an artifact branch', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'feature/some-feature',
        timestamp: 't',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal headRef (parseArtifactBranch rejects it)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/spec/../etc/passwd',
        timestamp: 't',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal plan headRef', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/plan/../etc/passwd',
        timestamp: 't',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal impl headRef', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'pull_request_merged',
        headRef: 'helm/impl/../etc/passwd',
        timestamp: 't',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransition).not.toHaveBeenCalled();
    });
  });
});
