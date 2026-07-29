import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockParseWebhook,
  mockCreate,
  mockTransition,
  mockSetSubStage,
  mockEnsureSubStages,
  mockReplayPendingReviewDispatchForItem,
} = vi.hoisted(() => ({
  mockParseWebhook: vi.fn(),
  mockCreate: vi.fn(),
  mockTransition: vi.fn(),
  mockSetSubStage: vi.fn(),
  mockEnsureSubStages: vi.fn(),
  mockReplayPendingReviewDispatchForItem: vi.fn(),
}));

vi.mock('../services/dispatch-scheduler.js', () => ({
  scheduleItemDispatch: vi.fn(),
  persistReviewDispatchIntent: vi.fn(),
  replayPendingReviewDispatchForItem: mockReplayPendingReviewDispatchForItem,
  peekPendingExternalReviewByRevision: vi.fn(),
  clearPendingExternalReview: vi.fn(),
  resumePendingExternalReview: vi.fn(),
  resumePendingExternalReviewByRevision: vi.fn(),
}));

vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    // The same Linear adapter serves parseWebhook AND writeback (setSubStage),
    // so writeback (anti-echo) is observable through this single stub.
    getIssueTrackerAdapter: vi.fn().mockResolvedValue({
      parseWebhook: mockParseWebhook,
      setSubStage: mockSetSubStage,
      ensureSubStages: mockEnsureSubStages,
    }),
    getItemStore: vi.fn().mockResolvedValue({ create: mockCreate, transition: mockTransition }),
    getProductConfig: vi.fn().mockResolvedValue({
      product: { slug: 'mome', name: 'MOME' },
      issue_tracker: {
        provider: 'linear',
        api_key_env: 'LINEAR_API_KEY',
        team_key: 'MOM',
        webhook_secret_env: 'LINEAR_WEBHOOK_SECRET',
      },
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_SECRET = 'linear-webhook-secret';

function sign(body: string): string {
  return createHmac('sha256', TEST_SECRET).update(body).digest('hex');
}

async function post(body: string, overrideSig?: string | null): Promise<Response> {
  const sig = overrideSig === null ? undefined : (overrideSig ?? sign(body));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig !== undefined) headers['linear-signature'] = sig;
  return app.request('/api/webhooks/linear', { method: 'POST', headers, body });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/linear', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
    process.env.LINEAR_WEBHOOK_SECRET = TEST_SECRET;
    mockReplayPendingReviewDispatchForItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  describe('authentication', () => {
    it('returns 503 when provider is not linear', async () => {
      const { getProductConfig } = await import('../services/index.js');
      vi.mocked(getProductConfig).mockResolvedValueOnce({
        product: { slug: 'helm', name: 'Helm' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
      } as Awaited<ReturnType<typeof getProductConfig>>);
      const res = await post('{}');
      expect(res.status).toBe(503);
    });

    it('returns 503 when LINEAR_WEBHOOK_SECRET is not set', async () => {
      delete process.env.LINEAR_WEBHOOK_SECRET;
      const res = await post('{}');
      expect(res.status).toBe(503);
    });

    it('returns 401 when signature is missing', async () => {
      const res = await post('{}', null);
      expect(res.status).toBe(401);
    });

    it('returns 401 when signature is invalid', async () => {
      const res = await post('{}', 'a'.repeat(64));
      expect(res.status).toBe(401);
    });

    it('returns 400 when body is not valid JSON (but signature is valid)', async () => {
      const body = 'not-json';
      const res = await post(body, sign(body));
      expect(res.status).toBe(400);
    });
  });

  describe('dispatch: item_created', () => {
    it('calls itemStore.create and returns 200', async () => {
      const body = JSON.stringify({
        type: 'Issue',
        action: 'create',
        data: { identifier: 'MOM-42' },
      });
      mockParseWebhook.mockReturnValue({
        type: 'item_created',
        externalId: 'MOM-42',
        timestamp: 't',
      });
      mockCreate.mockResolvedValue({ history: [] });

      const res = await post(body);

      expect(res.status).toBe(200);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'MOM-42',
          productSlug: 'mome',
          triggeredBy: 'webhook:linear',
        }),
      );
    });

    it('returns 200 when item already exists (idempotent)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_created',
        externalId: 'MOM-1',
        timestamp: 't',
      });
      const { ItemAlreadyExistsError } = await import('../services/errors.js');
      mockCreate.mockRejectedValue(new ItemAlreadyExistsError('MOM-1'));

      const res = await post(body);
      expect(res.status).toBe(200);
    });
  });

  describe('dispatch: item_updated with subStage', () => {
    it('calls itemStore.transition and returns 200', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'MOM-5',
        subStage: 'spec-ready',
        timestamp: 't',
      });
      mockTransition.mockResolvedValue({ history: [] });

      const res = await post(body);
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'MOM-5', toStage: 'spec-ready' }),
      );
      // Anti-echo (ADR-033): a Linear-originated transition (webhook:linear) must
      // NOT be written back to Linear.
      expect(mockSetSubStage).not.toHaveBeenCalled();
    });

    it('replays pending draft review dispatch after a Linear stage transition', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'MOM-5',
        subStage: 'plan-draft',
        timestamp: 't',
      });
      mockTransition.mockResolvedValue({ history: [], currentStage: 'plan-draft' });

      const res = await post(body);
      expect(res.status).toBe(200);
      expect(mockReplayPendingReviewDispatchForItem).toHaveBeenCalledWith({
        product: expect.objectContaining({ product: { slug: 'mome', name: 'MOME' } }),
        productSlug: 'mome',
        externalId: 'MOM-5',
      });
    });

    it('returns 200 on WorkflowTransitionError (not a delivery problem)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'MOM-5',
        subStage: 'released',
        timestamp: 't',
      });
      const { WorkflowTransitionError } = await import('@helm/workflow');
      mockTransition.mockRejectedValue(
        new WorkflowTransitionError('Invalid transition', 'discovery', 'released'),
      );

      const res = await post(body);
      expect(res.status).toBe(200);
    });

    it('returns 200 on ItemNotFoundError (not a delivery problem)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'MOM-99',
        subStage: 'spec-ready',
        timestamp: 't',
      });
      const { ItemNotFoundError } = await import('../services/errors.js');
      mockTransition.mockRejectedValue(new ItemNotFoundError('MOM-99'));

      const res = await post(body);
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected transition error', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_updated',
        externalId: 'MOM-5',
        subStage: 'spec-ready',
        timestamp: 't',
      });
      mockTransition.mockRejectedValue(new Error('DB exploded'));

      const res = await post(body);
      expect(res.status).toBe(500);
    });
  });

  describe('dispatch: comment_added', () => {
    it('returns 200 (no-op in v0)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'comment_added',
        externalId: 'MOM-3',
        body: 'Nice!',
        timestamp: 't',
      });

      const res = await post(body);
      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
    });
  });

  describe('dispatch: unknown event', () => {
    it('returns 200 without dispatching (no-op)', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({ type: 'unknown', raw: {} });

      const res = await post(body);
      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('defense-in-depth: externalId validation', () => {
    it('returns 200 and skips dispatch for invalid externalId', async () => {
      const body = JSON.stringify({});
      mockParseWebhook.mockReturnValue({
        type: 'item_created',
        externalId: '../../../etc/passwd',
        timestamp: 't',
      });

      const res = await post(body);
      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
