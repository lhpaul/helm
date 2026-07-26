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
  mockTransitionIfCurrentStage,
  mockList,
  mockGet,
  mockSetSubStage,
  mockEnsureSubStages,
  mockScheduleItemDispatch,
  mockPersistReviewDispatchIntent,
  mockPeekPendingExternalReviewByRevision,
  mockClearPendingExternalReview,
  mockResumePendingExternalReview,
  mockResumePendingExternalReviewByRevision,
  mockResolveOpenPrMetadata,
  mockAuthorHasWriteAccess,
  mockGetPrimaryCodeRepo,
  mockListPrIssueComments,
  mockUpsertResolvedProductDecision,
} = vi.hoisted(() => ({
  mockParseWebhook: vi.fn(),
  mockCreate: vi.fn(),
  mockTransition: vi.fn(),
  mockTransitionIfCurrentStage: vi.fn(),
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockSetSubStage: vi.fn(),
  mockEnsureSubStages: vi.fn(),
  mockScheduleItemDispatch: vi.fn(),
  mockPersistReviewDispatchIntent: vi.fn(),
  mockPeekPendingExternalReviewByRevision: vi.fn(),
  mockClearPendingExternalReview: vi.fn(),
  mockResumePendingExternalReview: vi.fn(),
  mockResumePendingExternalReviewByRevision: vi.fn(),
  mockResolveOpenPrMetadata: vi.fn(),
  mockAuthorHasWriteAccess: vi.fn(),
  mockGetPrimaryCodeRepo: vi.fn(),
  mockListPrIssueComments: vi.fn(),
  mockUpsertResolvedProductDecision: vi.fn(),
}));

vi.mock('../services/dispatch-scheduler.js', () => ({
  scheduleItemDispatch: mockScheduleItemDispatch,
  persistReviewDispatchIntent: mockPersistReviewDispatchIntent,
  peekPendingExternalReviewByRevision: mockPeekPendingExternalReviewByRevision,
  clearPendingExternalReview: mockClearPendingExternalReview,
  resumePendingExternalReview: mockResumePendingExternalReview,
  resumePendingExternalReviewByRevision: mockResumePendingExternalReviewByRevision,
}));

vi.mock('../services/github-pr.js', () => ({
  resolveOpenPrMetadata: mockResolveOpenPrMetadata,
  authorHasWriteAccess: mockAuthorHasWriteAccess,
  getPrimaryCodeRepo: mockGetPrimaryCodeRepo,
  listPrIssueComments: mockListPrIssueComments,
  parseGitHubRepoUrl: (url: string) => {
    const parsed = new URL(url);
    const [owner, repoWithSuffix] = parsed.pathname.replace(/^\/+/, '').split('/');
    return { owner, repo: repoWithSuffix?.replace(/\.git$/, '') };
  },
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
      transitionIfCurrentStage: mockTransitionIfCurrentStage,
      list: mockList,
      get: mockGet,
      upsertResolvedProductDecision: mockUpsertResolvedProductDecision,
    }),
    getProductConfig: vi.fn().mockResolvedValue({
      product: { slug: 'test-app', name: 'Test' },
      issue_tracker: {
        provider: 'github_projects',
        org: 'test-org',
        project_number: 1,
        custom_field_name: 'Helm Stage',
      },
      code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
      knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
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
  opts: {
    action?: string;
    merged?: boolean;
    senderLogin?: string;
    prNumber?: number;
    headSha?: string;
    owner?: string;
    repo?: string;
  } = {},
): string {
  const payload: Record<string, unknown> = {
    action: opts.action ?? 'closed',
    pull_request: {
      id: 1000 + (opts.prNumber ?? 42),
      number: opts.prNumber ?? 42,
      merged: opts.merged ?? true,
      head: { ref: headRef, sha: opts.headSha ?? 'sha-sync-1' },
    },
    repository: {
      name: opts.repo ?? 'test-repo',
      owner: { login: opts.owner ?? 'test-org' },
    },
  };
  if (opts.senderLogin) {
    payload.sender = { login: opts.senderLogin };
  }
  return JSON.stringify(payload);
}

function prCommentPayload(
  body: string,
  opts: {
    action?: string;
    prNumber?: number;
    owner?: string;
    repo?: string;
    authorLogin?: string;
  } = {},
): string {
  return JSON.stringify({
    action: opts.action ?? 'created',
    issue: { number: opts.prNumber ?? 42, pull_request: { url: 'https://api.github.com/pr' } },
    comment: { body, user: { login: opts.authorLogin ?? 'maintainer' } },
    repository: {
      name: opts.repo ?? 'test-repo',
      owner: { login: opts.owner ?? 'test-org' },
    },
  });
}

function haystackCheckRunPayload(
  opts: {
    conclusion?: string;
    prNumber?: number;
    headSha?: string;
    headRef?: string;
    noPullRequests?: boolean;
    owner?: string;
    repo?: string;
  } = {},
): string {
  return JSON.stringify({
    action: 'completed',
    check_run: {
      name: 'Haystack / Review',
      status: 'completed',
      conclusion: opts.conclusion ?? 'success',
      head_sha: opts.headSha ?? 'sha-42',
      app: { slug: 'haystack-code-reviewer-pr-hook' },
      pull_requests: opts.noPullRequests
        ? []
        : [
            {
              number: opts.prNumber ?? 42,
              head: { ref: opts.headRef ?? 'helm/impl/issue_42' },
            },
          ],
    },
    repository: {
      name: opts.repo ?? 'test-repo',
      owner: { login: opts.owner ?? 'test-org' },
    },
  });
}

function haystackStatusPayload(
  opts: {
    targetRevision?: string;
    prNumber?: number;
    headRef?: string;
    owner?: string;
    repo?: string;
  } = {},
): string {
  const prNumber = opts.prNumber ?? 42;
  return JSON.stringify({
    context: 'Haystack / Review',
    state: 'success',
    sha: opts.targetRevision ?? 'sha-42',
    target_url: `https://github.com/${opts.owner ?? 'test-org'}/${opts.repo ?? 'test-repo'}/pull/${prNumber}/checks`,
    branches: [{ name: opts.headRef ?? 'helm/impl/issue_42' }],
    repository: {
      name: opts.repo ?? 'test-repo',
      owner: { login: opts.owner ?? 'test-org' },
    },
  });
}

const MARKDOWN_DECISION = [
  '<!-- helm:product-decision -->',
  '- **product_decision** · Pick direction',
  '- **Chosen option:** Option A',
].join('\n');

const LEGACY_STRUCTURED_DECISION = [
  '<!-- helm:product-decision -->',
  'Conflict kind: product_decision',
  'Conflict title: Pick direction',
  'Chosen option: Option A',
].join('\n');

const SPEC_STRUCTURED_DECISION = [
  '<!-- helm:product-decision -->',
  '- **Conflict:** product_decision · Pick direction',
  '- **Chosen:** Option A',
].join('\n');

const HUMAN_REQUIRED_ADJUDICATION = [
  '# Review Adjudication: issue_42',
  '',
  '## Conflicts',
  '- **product_decision** · Pick direction',
  '  Option A: keep the current review-loop behavior.',
  '  Option B: change review-loop behavior.',
  '',
  '## Unified remediation plan',
  '- **DEFERRED** · Pick direction — awaiting human decision',
  '',
  '## Status',
  'HUMAN_REQUIRED',
].join('\n');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/github', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    process.env.GITHUB_TOKEN = 'test-github-token';
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
      code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
      knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
      workflow: { final_stage: 'released' },
    } as never);
    vi.mocked(getGitHubAdapter).mockResolvedValue({ parseWebhook: mockParseWebhook } as never);
    // Writeback adapter stub (ADR-033): ensureSubStages + setSubStage resolve so
    // a successful writeback can be asserted; clearAllMocks wiped the impls.
    mockEnsureSubStages.mockResolvedValue(undefined);
    mockSetSubStage.mockResolvedValue(undefined);
    mockScheduleItemDispatch.mockResolvedValue({ scheduled: true, jobId: 'job-sync-1' });
    mockPersistReviewDispatchIntent.mockResolvedValue(undefined);
    mockResumePendingExternalReview.mockResolvedValue({ scheduled: true, jobId: 'job-resume-1' });
    mockResumePendingExternalReviewByRevision.mockResolvedValue({
      scheduled: true,
      jobId: 'job-resume-by-revision-1',
      externalId: 'issue_42',
    });
    mockGetPrimaryCodeRepo.mockReturnValue({ owner: 'test-org', repo: 'test-repo' });
    mockAuthorHasWriteAccess.mockResolvedValue(true);
    mockResolveOpenPrMetadata.mockResolvedValue({
      owner: 'test-org',
      repo: 'test-repo',
      number: 42,
      headRef: 'helm/impl/issue_42',
      headSha: 'sha-42',
      htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
    });
    mockListPrIssueComments.mockResolvedValue([{ id: 1, body: HUMAN_REQUIRED_ADJUDICATION }]);
    mockUpsertResolvedProductDecision.mockResolvedValue({
      inserted: true,
      state: { currentStage: 'code-review' },
    });
    mockGet.mockResolvedValue(null);
    vi.mocked(getIssueTrackerAdapter).mockResolvedValue({
      setSubStage: mockSetSubStage,
      ensureSubStages: mockEnsureSubStages,
    } as never);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_TOKEN;
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

  describe('dispatch: pull_request_comment_created', () => {
    it('schedules reviewer-fanout for an authorized structured decision on the impl PR', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockAuthorHasWriteAccess).toHaveBeenCalledWith(
        expect.objectContaining({ login: 'maintainer' }),
      );
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'issue_42',
        specialistId: 'reviewer-fanout',
        targetRevision: 'sha-42',
        prNumber: 42,
        triggeredBy: 'webhook:pr-decision-comment',
      });
      expect(mockUpsertResolvedProductDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          decision: expect.objectContaining({
            conflictKind: 'product_decision',
            conflictTitle: 'Pick direction',
            chosenOption: 'Option A',
            source: expect.objectContaining({
              provider: 'github',
              owner: 'test-org',
              repo: 'test-repo',
              prNumber: 42,
              authorLogin: 'maintainer',
            }),
          }),
          triggeredBy: 'webhook:pr-decision-comment',
        }),
      );
    });

    it('preserves fallback parsing for legacy structured decisions', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(prCommentPayload(LEGACY_STRUCTURED_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          specialistId: 'reviewer-fanout',
        }),
      );
    });

    it('accepts the spec structured decision labels', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(prCommentPayload(SPEC_STRUCTURED_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          specialistId: 'reviewer-fanout',
        }),
      );
    });

    it('keeps duplicate decisions idempotent before redispatching', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockUpsertResolvedProductDecision.mockResolvedValue({
        inserted: false,
        state: { currentStage: 'code-review' },
      });

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockUpsertResolvedProductDecision).toHaveBeenCalledTimes(1);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          specialistId: 'reviewer-fanout',
        }),
      );
    });

    it('persists structured decisions after code-review without dispatching fanout', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'merged',
        history: [],
      });
      mockUpsertResolvedProductDecision.mockResolvedValue({
        inserted: true,
        state: { currentStage: 'merged' },
      });

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockUpsertResolvedProductDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          triggeredBy: 'webhook:pr-decision-comment',
        }),
      );
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
      expect(mockPersistReviewDispatchIntent).not.toHaveBeenCalled();
    });

    it('uses the post-upsert stage so a concurrent advance past code-review skips fanout', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockUpsertResolvedProductDecision.mockResolvedValue({
        inserted: true,
        state: { currentStage: 'merged' },
      });

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockUpsertResolvedProductDecision).toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
      expect(mockPersistReviewDispatchIntent).not.toHaveBeenCalled();
    });

    it('ignores structured decisions that do not match the latest adjudication record', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockListPrIssueComments.mockResolvedValue([
        { id: 1, body: HUMAN_REQUIRED_ADJUDICATION },
        {
          id: 2,
          body: [
            '# Review Adjudication: issue_42',
            '',
            '## Conflicts',
            '- **product_decision** · Different direction',
            '  Option B: choose another path.',
            '',
            '## Status',
            'HUMAN_REQUIRED',
          ].join('\n'),
        },
      ]);

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
      expect(mockUpsertResolvedProductDecision).not.toHaveBeenCalled();
    });

    it('returns 503 when structured decision processing unexpectedly fails', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockListPrIssueComments.mockRejectedValue(new Error('GitHub API failed'));

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(503);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('returns 503 when GITHUB_TOKEN is missing for an authorized decision path', async () => {
      delete process.env.GITHUB_TOKEN;
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(503);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
      expect(mockPersistReviewDispatchIntent).not.toHaveBeenCalled();
    });

    it('persists a pending intent when scheduling rejects after an authorized decision', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockScheduleItemDispatch.mockResolvedValue({
        scheduled: false,
        reason: 'Unable to schedule dispatch',
      });

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockPersistReviewDispatchIntent).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'issue_42',
        prNumber: 42,
        targetRevision: 'sha-42',
        triggeredBy: 'webhook:pr-decision-comment',
      });
    });

    it('persists checklist decisions without the Helm HTML marker', async () => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      const unmarkedChecklist = [
        '- [x] **product_decision** · Pick direction',
        '- **Chosen option:** Option A',
      ].join('\n');

      const res = await post(prCommentPayload(unmarkedChecklist), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockUpsertResolvedProductDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          decision: expect.objectContaining({
            conflictKind: 'product_decision',
            conflictTitle: 'Pick direction',
            chosenOption: 'Option A',
          }),
        }),
      );
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          specialistId: 'reviewer-fanout',
        }),
      );
    });

    it('ignores unmarked PR comments', async () => {
      const res = await post(prCommentPayload('LGTM'), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockAuthorHasWriteAccess).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores malformed marker-bearing comments', async () => {
      const res = await post(prCommentPayload('<!-- helm:product-decision -->'), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockAuthorHasWriteAccess).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores edited marker-bearing comments', async () => {
      const res = await post(
        prCommentPayload(MARKDOWN_DECISION, { action: 'edited' }),
        'issue_comment',
      );

      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores comments on the wrong repository', async () => {
      const res = await post(
        prCommentPayload(MARKDOWN_DECISION, { repo: 'other-repo' }),
        'issue_comment',
      );

      expect(res.status).toBe(200);
      expect(mockAuthorHasWriteAccess).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores marker-bearing comments from users without write access', async () => {
      mockAuthorHasWriteAccess.mockResolvedValue(false);

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores structured decisions on the wrong PR head', async () => {
      mockResolveOpenPrMetadata.mockResolvedValue({
        owner: 'test-org',
        repo: 'test-repo',
        number: 42,
        headRef: 'helm/impl/issue_99',
        headSha: 'sha-99',
        htmlUrl: 'https://github.com/test-org/test-repo/pull/42',
      });
      mockGet.mockResolvedValue(null);

      const res = await post(prCommentPayload(MARKDOWN_DECISION), 'issue_comment');

      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });
  });

  describe('dispatch: pull_request_merged', () => {
    beforeEach(() => {
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'spec-draft',
        history: [],
      });
    });

    // Fix 1: pull_request events are parsed by the pure parseGitHubWebhook — the
    // GitHub Projects adapter is NOT consulted. Each test sends a real PR payload.

    // ── Spec merge (helm/spec/ → spec-ready) ────────────────────────────────

    it('transitions spec-draft → spec-ready when helm/spec/ branch is merged', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      // Writeback reads the resulting ItemState, so the mock returns a realistic one.
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { externalId: 'issue_42', currentStage: 'spec-ready', history: [] },
        applied: true,
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith({
        externalId: 'issue_42',
        fromStage: 'spec-draft',
        toStage: 'spec-ready',
        triggeredBy: 'webhook:knowledge-repo',
        note: expect.stringContaining('merge-reconciliation:test-org/test-repo#id:1042:spec-ready'),
        idempotencyKey: 'merge-reconciliation:test-org/test-repo#id:1042:spec-ready',
      });
      // Fix 1: the GitHub Projects adapter is never consulted for pull_request events.
      expect(getGitHubAdapter).not.toHaveBeenCalled();
      // Writeback (ADR-033): webhook:knowledge-repo is NOT tracker-originated, so
      // the new stage IS pushed back to the tracker.
      expect(mockSetSubStage).toHaveBeenCalledWith('issue_42', 'spec-ready');
    });

    it('returns 200 when spec merge is already past spec-draft (idempotent no-op)', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { externalId: 'issue_42', currentStage: 'spec-ready', history: [] },
        applied: false,
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          fromStage: 'spec-draft',
          toStage: 'spec-ready',
        }),
      );
    });

    it('returns 200 on ItemNotFoundError for spec merge (item not in this Helm instance)', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      mockGet.mockResolvedValue(null);

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during spec merge transition', async () => {
      const body = mergedPrPayload('helm/spec/issue_42');
      mockTransitionIfCurrentStage.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Plan merge (helm/plan/ → plan-ready) ─────────────────────────────────

    it('transitions plan-draft → plan-ready when helm/plan/ branch is merged', async () => {
      const body = mergedPrPayload('helm/plan/issue_42');
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'plan-draft',
        history: [],
      });
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { currentStage: 'plan-ready', history: [] },
        applied: true,
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith({
        externalId: 'issue_42',
        fromStage: 'plan-draft',
        toStage: 'plan-ready',
        triggeredBy: 'webhook:knowledge-repo',
        note: expect.stringContaining('merge-reconciliation:test-org/test-repo#id:1042:plan-ready'),
        idempotencyKey: 'merge-reconciliation:test-org/test-repo#id:1042:plan-ready',
      });
    });

    it('returns 200 when plan merge is already past plan-draft (idempotent no-op)', async () => {
      const body = mergedPrPayload('helm/plan/issue_42');
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { externalId: 'issue_42', currentStage: 'plan-ready', history: [] },
        applied: false,
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          fromStage: 'plan-draft',
          toStage: 'plan-ready',
        }),
      );
    });

    it('returns 200 on ItemNotFoundError for plan merge (item not in this Helm instance)', async () => {
      const body = mergedPrPayload('helm/plan/HLM-7');
      mockGet.mockResolvedValue(null);

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during plan merge transition', async () => {
      const body = mergedPrPayload('helm/plan/issue_42');
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'plan-draft',
        history: [],
      });
      mockTransitionIfCurrentStage.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Impl merge (helm/impl/ → merged) ────────────────────────────────────
    // ADR-032: the impl PR merge now lands the item in `merged`, NOT `released`.
    // `released` is reached only via the release trigger (endpoint / webhook).

    it('transitions code-review → merged when helm/impl/ branch is merged', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { currentStage: 'merged', history: [] },
        applied: true,
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith({
        externalId: 'issue_42',
        fromStage: 'code-review',
        toStage: 'merged',
        triggeredBy: 'webhook:code-repo',
        note: expect.stringContaining('merge-reconciliation:test-org/test-repo#id:1042:merged'),
        idempotencyKey: 'merge-reconciliation:test-org/test-repo#id:1042:merged',
      });
    });

    it('returns 200 when impl merge is already past code-review (idempotent no-op)', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { externalId: 'issue_42', currentStage: 'merged', history: [] },
        applied: false,
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'issue_42',
          fromStage: 'code-review',
          toStage: 'merged',
        }),
      );
    });

    it('returns 200 on ItemNotFoundError for impl merge (item not in this Helm instance)', async () => {
      const body = mergedPrPayload('helm/impl/HLM-7');
      mockGet.mockResolvedValue(null);

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
    });

    it('returns 500 on unexpected error during impl merge transition', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });
      mockTransitionIfCurrentStage.mockRejectedValue(new Error('storage failure'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(500);
    });

    // ── Draft PR open/synchronize (helm/spec|plan/ → early review loop) ─────

    it('schedules spec-draft-reviewer when a helm/spec/ PR opens and early loop is enabled', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { early_loop: { enabled: true } },
      } as never);
      const body = mergedPrPayload('helm/spec/LEA-192', {
        action: 'opened',
        merged: false,
        prNumber: 76,
        headSha: 'sha-spec-192',
      });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'spec-draft',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'LEA-192',
        specialistId: 'spec-draft-reviewer',
        targetRevision: 'sha-spec-192',
        prNumber: 76,
        triggeredBy: 'webhook:spec-pr-sync',
      });
    });

    it('schedules plan-draft-reviewer when a helm/plan/ PR syncs and early loop is enabled', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { early_loop: { enabled: true } },
      } as never);
      const body = mergedPrPayload('helm/plan/LEA-192', {
        action: 'synchronize',
        merged: false,
        prNumber: 78,
        headSha: 'sha-plan-192',
      });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'plan-draft',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'LEA-192',
        specialistId: 'plan-draft-reviewer',
        targetRevision: 'sha-plan-192',
        prNumber: 78,
        triggeredBy: 'webhook:plan-pr-sync',
      });
    });

    it('schedules draft reviewer for artifact PRs in a separate knowledge repo', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/knowledge-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { early_loop: { enabled: true } },
      } as never);
      const body = mergedPrPayload('helm/spec/LEA-192', {
        action: 'synchronize',
        merged: false,
        owner: 'test-org',
        repo: 'knowledge-repo',
        prNumber: 80,
        headSha: 'sha-spec-knowledge-192',
      });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'spec-draft',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'LEA-192',
        specialistId: 'spec-draft-reviewer',
        targetRevision: 'sha-spec-knowledge-192',
        prNumber: 80,
        triggeredBy: 'webhook:spec-pr-sync',
      });
    });

    it('skips draft PR dispatch when an orchestrator sender syncs the branch', async () => {
      const body = mergedPrPayload('helm/spec/LEA-192', {
        action: 'synchronize',
        merged: false,
        senderLogin: 'helm-bot',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('schedules plan-draft-reviewer when a helm/plan/ PR opens and early loop is enabled', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { early_loop: { enabled: true } },
      } as never);
      const body = mergedPrPayload('helm/plan/LEA-192', {
        action: 'opened',
        merged: false,
        prNumber: 79,
        headSha: 'sha-plan-open-192',
      });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'plan-draft',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'LEA-192',
        specialistId: 'plan-draft-reviewer',
        targetRevision: 'sha-plan-open-192',
        prNumber: 79,
        triggeredBy: 'webhook:plan-pr-sync',
      });
    });

    it('skips draft PR dispatch when the webhook repository does not match the knowledge repo', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { early_loop: { enabled: true } },
      } as never);
      const body = mergedPrPayload('helm/spec/LEA-192', {
        action: 'synchronize',
        merged: false,
        owner: 'other-org',
        repo: 'other-repo',
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('skips draft PR dispatch when early loop is disabled', async () => {
      const body = mergedPrPayload('helm/spec/LEA-192', {
        action: 'synchronize',
        merged: false,
      });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'spec-draft',
        history: [],
      });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('returns 200 when draft reviewer dispatch lookup fails', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { early_loop: { enabled: true } },
      } as never);
      const body = mergedPrPayload('helm/spec/LEA-192', {
        action: 'synchronize',
        merged: false,
      });
      mockGet.mockResolvedValue({
        externalId: 'LEA-192',
        productSlug: 'test-app',
        currentStage: 'spec-draft',
        history: [],
      });
      mockScheduleItemDispatch.mockRejectedValue(new Error('unknown specialist'));

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockScheduleItemDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ specialistId: 'spec-draft-reviewer' }),
      );
    });

    // ── Impl PR synchronize (helm/impl/ → re-dispatch reviewer-fanout) ─────

    it('schedules reviewer-fanout when helm/impl/ PR syncs and item is in code-review', async () => {
      const body = mergedPrPayload('helm/impl/LEA-192', {
        action: 'synchronize',
        merged: false,
        prNumber: 77,
        headSha: 'sha-lea-192',
      });
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
        specialistId: 'reviewer-fanout',
        targetRevision: 'sha-lea-192',
        prNumber: 77,
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

    it('resumes deferred external review from a matching Haystack check run', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(haystackCheckRunPayload(), 'check_run');

      expect(res.status).toBe(200);
      expect(mockResumePendingExternalReview).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'issue_42',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-42',
        triggeredBy: 'webhook:external-review-ready',
      });
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores generic status success events as readiness (Option B)', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(haystackStatusPayload(), 'status');

      expect(res.status).toBe(200);
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
      expect(mockResumePendingExternalReviewByRevision).not.toHaveBeenCalled();
      expect(mockClearPendingExternalReview).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('resumes by revision first when check run includes PR metadata', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockPeekPendingExternalReviewByRevision.mockResolvedValue({
        kind: 'pending_external_review',
        productSlug: 'test-app',
        externalId: 'issue_42',
        provider: 'haystack',
        reason: 'analysis_pending',
        prNumber: 42,
        targetRevision: 'sha-42',
        createdAt: '2026-07-22T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        triggeredBy: 'test',
        updatedAt: '2026-07-22T10:00:00.000Z',
      });
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(haystackCheckRunPayload(), 'check_run');

      expect(res.status).toBe(200);
      expect(mockResumePendingExternalReviewByRevision).toHaveBeenCalledWith({
        productSlug: 'test-app',
        provider: 'haystack',
        targetRevision: 'sha-42',
        triggeredBy: 'webhook:external-review-ready',
      });
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
    });

    it('resumes deferred external review by revision when check run omits PR metadata', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockPeekPendingExternalReviewByRevision.mockResolvedValue({
        kind: 'pending_external_review',
        productSlug: 'test-app',
        externalId: 'issue_42',
        provider: 'haystack',
        reason: 'analysis_pending',
        prNumber: 42,
        targetRevision: 'sha-42',
        createdAt: '2026-07-22T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        triggeredBy: 'test',
        updatedAt: '2026-07-22T10:00:00.000Z',
      });
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'code-review',
        history: [],
      });

      const res = await post(haystackCheckRunPayload({ noPullRequests: true }), 'check_run');

      expect(res.status).toBe(200);
      expect(mockPeekPendingExternalReviewByRevision).toHaveBeenCalledWith({
        productSlug: 'test-app',
        provider: 'haystack',
        targetRevision: 'sha-42',
      });
      expect(mockResumePendingExternalReviewByRevision).toHaveBeenCalledWith({
        productSlug: 'test-app',
        provider: 'haystack',
        targetRevision: 'sha-42',
        triggeredBy: 'webhook:external-review-ready',
      });
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    it('ignores external review readiness for a non-impl branch', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);

      const res = await post(
        haystackCheckRunPayload({ headRef: 'helm/spec/issue_42' }),
        'check_run',
      );

      expect(res.status).toBe(200);
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
    });

    it('clears matching pending external review when readiness arrives after code-review', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'merged',
        history: [],
      });

      const res = await post(haystackCheckRunPayload(), 'check_run');

      expect(res.status).toBe(200);
      expect(mockClearPendingExternalReview).toHaveBeenCalledWith({
        productSlug: 'test-app',
        externalId: 'issue_42',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'sha-42',
      });
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
    });

    it('ignores status success after code-review under Option B (no readiness path)', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'test-app',
        currentStage: 'merged',
        history: [],
      });

      const res = await post(haystackStatusPayload(), 'status');

      expect(res.status).toBe(200);
      expect(mockClearPendingExternalReview).not.toHaveBeenCalled();
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
    });

    it('rejects readiness when headRef steers a different item than the revision match', async () => {
      vi.mocked(getProductConfig).mockResolvedValue({
        product: { slug: 'test-app', name: 'Test' },
        issue_tracker: {
          provider: 'github_projects',
          org: 'test-org',
          project_number: 1,
          custom_field_name: 'Helm Stage',
        },
        code_repos: [{ url: 'https://github.com/test-org/test-repo', role: 'app' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
        workflow: { final_stage: 'released' },
        review: { external: { provider: 'haystack', resume_on_check_run: true } },
      } as never);
      mockPeekPendingExternalReviewByRevision.mockResolvedValue({
        kind: 'pending_external_review',
        productSlug: 'test-app',
        externalId: 'issue_42',
        provider: 'haystack',
        reason: 'analysis_pending',
        prNumber: 42,
        targetRevision: 'sha-42',
        createdAt: '2026-07-22T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        triggeredBy: 'test',
        updatedAt: '2026-07-22T10:00:00.000Z',
      });

      const res = await post(
        haystackCheckRunPayload({ headRef: 'helm/impl/issue_99' }),
        'check_run',
      );

      expect(res.status).toBe(200);
      expect(mockResumePendingExternalReview).not.toHaveBeenCalled();
      expect(mockResumePendingExternalReviewByRevision).not.toHaveBeenCalled();
      expect(mockScheduleItemDispatch).not.toHaveBeenCalled();
    });

    // ── Non-actionable PR actions ─────────────────────────────────────────────

    it('returns 200 without transition when PR is closed but not merged', async () => {
      const body = mergedPrPayload('helm/spec/issue_42', { merged: false });

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).not.toHaveBeenCalled();
    });

    // ── Non-artifact branches ─────────────────────────────────────────────────

    it('returns 200 without transition when branch is not an artifact branch', async () => {
      const body = mergedPrPayload('feature/some-feature');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal headRef (parseArtifactBranch rejects it)', async () => {
      const body = mergedPrPayload('helm/spec/../etc/passwd');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal plan headRef', async () => {
      const body = mergedPrPayload('helm/plan/../etc/passwd');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).not.toHaveBeenCalled();
    });

    it('returns 200 and does not transition for a dot-traversal impl headRef', async () => {
      const body = mergedPrPayload('helm/impl/../etc/passwd');

      const res = await post(body, 'pull_request');
      expect(res.status).toBe(200);
      expect(mockTransitionIfCurrentStage).not.toHaveBeenCalled();
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
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
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
        code_repos: [{ name: 'test-repo', url: 'https://github.com/test-org/test-repo' }],
        knowledge_repo: { url: 'https://github.com/test-org/test-repo', branch: 'main' },
      } as never);
      vi.mocked(getGitHubAdapter).mockRejectedValue(
        new Error('GitHub Projects adapter is not available for a linear product'),
      );
    });

    it('processes a pull_request_merged for a Linear product without the GitHub adapter', async () => {
      const body = mergedPrPayload('helm/impl/issue_42');
      mockGet.mockResolvedValue({
        externalId: 'issue_42',
        productSlug: 'mome',
        currentStage: 'code-review',
        history: [],
      });
      mockTransitionIfCurrentStage.mockResolvedValue({
        state: { currentStage: 'merged', history: [] },
        applied: true,
      });

      const res = await post(body, 'pull_request');

      expect(res.status).toBe(200);
      expect(getGitHubAdapter).not.toHaveBeenCalled();
      expect(mockTransitionIfCurrentStage).toHaveBeenCalledWith({
        externalId: 'issue_42',
        fromStage: 'code-review',
        toStage: 'merged',
        triggeredBy: 'webhook:code-repo',
        note: expect.stringContaining('merge-reconciliation:test-org/test-repo#id:1042:merged'),
        idempotencyKey: 'merge-reconciliation:test-org/test-repo#id:1042:merged',
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
