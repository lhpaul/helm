import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ItemTransitionFn } from '../specialists/spec-writer.js';
import type { RunGit } from '../specialists/git-helpers.js';
import { MockAgentRuntime } from '../runtimes/mock.js';
import {
  runCodeReviewLoop,
  runEarlyArtifactReviewLoop,
  formatExternalBlockersForRemediation,
  buildFindingsByKind,
} from './code-review-loop.js';

vi.mock('../specialists/reviewer-fanout.js', () => ({
  fanoutReviewers: vi.fn(),
  shouldRemediate: vi.fn(),
}));
vi.mock('../specialists/remediation.js', () => ({
  buildRemediationParams: vi.fn().mockReturnValue({
    specialistId: 'code-remediator',
    prompt: 'remediate',
    workdir: '/tmp/ws',
    productSlug: 'test',
    externalId: 'issue_1',
    permissionMode: 'bypassPermissions',
    timeoutMs: 1000,
  }),
  handleRemediationResult: vi.fn().mockResolvedValue({
    status: 'done',
    costUsd: 0.02,
    durationMs: 200,
    commentPosted: true,
    pushed: true,
    commitSha: 'sha789',
  }),
}));
vi.mock('../specialists/review-adjudicator.js', () => ({
  buildReviewAdjudicatorParams: vi.fn(),
  handleReviewAdjudicatorResult: vi.fn(),
}));
vi.mock('../specialists/fetch-product-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../specialists/fetch-product-context.js')>();
  return {
    ...actual,
    fetchSpecForPlan: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('../specialists/code-workspace.js', () => ({
  EXTERNAL_ID_SAFE: /^(?!\.)[A-Za-z0-9._-]+$/,
  provisionReviewerWorkspace: vi.fn().mockResolvedValue({
    workspacePath: '/tmp/ws',
    branchName: 'helm/impl/issue_1',
    artifactsPath: '/tmp/ws-artifacts',
  }),
  artifactsDirFor: vi.fn((workspacePath: string) => `${workspacePath}-artifacts`),
}));
vi.mock('../external-review/run.js', () => ({
  runExternalReviewIfConfigured: vi.fn().mockResolvedValue({
    status: 'skipped',
    reason: 'not_configured',
  }),
  parsePullRequestRef: vi.fn((prUrl: string) => {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prNumber: Number(match[3]) };
  }),
}));
vi.mock('../specialists/pr-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../specialists/pr-helpers.js')>();
  return {
    ...actual,
    postPRComment: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('./false-positives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./false-positives.js')>();
  return {
    ...actual,
    fetchFalsePositivesCatalog: vi.fn().mockResolvedValue([]),
  };
});
vi.mock('./summary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./summary.js')>();
  return {
    ...actual,
    upsertReviewLoopSummaryComment: vi.fn().mockResolvedValue(undefined),
  };
});

import { fanoutReviewers, shouldRemediate } from '../specialists/reviewer-fanout.js';
import { buildRemediationParams, handleRemediationResult } from '../specialists/remediation.js';
import {
  buildReviewAdjudicatorParams,
  handleReviewAdjudicatorResult,
} from '../specialists/review-adjudicator.js';
import { provisionReviewerWorkspace } from '../specialists/code-workspace.js';
import { fetchSpecForPlan } from '../specialists/fetch-product-context.js';
import { runExternalReviewIfConfigured } from '../external-review/run.js';
import { postPRComment } from '../specialists/pr-helpers.js';
import { buildAdvisorySummaryRows, upsertReviewLoopSummaryComment } from './summary.js';
import {
  builtInFalsePositiveEntries,
  fetchFalsePositivesCatalog,
  parseFalsePositivesCatalog,
} from './false-positives.js';
import type { ReviewerFanoutResult, ReviewerResult } from '../specialists/reviewer-fanout.js';
import type { ReviewLoopLedgerEntry, ReviewLoopLedgerUpdate } from './cumulative-ledger.js';

const PR_URL = 'https://github.com/o/r/pull/42';

const baseProduct = {
  helm_version: '0' as const,
  product: { slug: 'test', name: 'Test' },
  issue_tracker: {
    provider: 'github_projects' as const,
    org: 'o',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' as const }],
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
  workflow: {
    stages_enabled: ['code-review' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
    readiness_gate: 'skip' as const,
    final_stage: 'released' as const,
  },
  specialists: {
    'spec-writer': { runtime: 'claude_code' as const, model: 'm' },
    'plan-writer': { runtime: 'claude_code' as const, model: 'm' },
    implementer: { runtime: 'claude_code' as const, model: 'm' },
    'code-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'security-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'test-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'spec-remediator': { runtime: 'claude_code' as const, model: 'm' },
    'plan-remediator': { runtime: 'claude_code' as const, model: 'm' },
    'code-remediator': { runtime: 'claude_code' as const, model: 'm' },
  },
} satisfies Product;

function makeFanout(
  overrides: Partial<ReviewerFanoutResult> = {},
  findings: ReviewerResult['findings'] = { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
): ReviewerFanoutResult {
  return {
    reviewerResults: [
      {
        kind: 'code',
        status: 'done',
        costUsd: 0.01,
        durationMs: 50,
        commentPosted: true,
        findings,
        commentBody: 'fix this',
      },
    ],
    prUrl: PR_URL,
    status: 'done',
    costUsd: 0.03,
    durationMs: 100,
    ...overrides,
  };
}

describe('runCodeReviewLoop', () => {
  let transition: ReturnType<typeof vi.fn>;
  let runGit: RunGit;
  let tempDirs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirs = [];
    transition = vi.fn().mockResolvedValue({ currentStage: 'code-review' });
    runGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout({}, undefined));
    vi.mocked(shouldRemediate).mockReturnValue(false);
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'skipped',
      reason: 'not_configured',
    });
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue([]);
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: true,
      pushed: true,
      commitSha: 'sha789',
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
    vi.mocked(provisionReviewerWorkspace).mockResolvedValue({
      workspacePath: '/tmp/ws',
      branchName: 'helm/impl/issue_1',
      artifactsPath: '/tmp/ws-artifacts',
    });
  });

  const runLoop = (product: Product = baseProduct) =>
    runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

  it('returns done on a clean fan-out with no remediation', async () => {
    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'done',
      prUrl: PR_URL,
      cyclesCompleted: 1,
    });
    expect(result.newStage).toBeUndefined();
    expect(fanoutReviewers).toHaveBeenCalledTimes(1);
    expect(transition).not.toHaveBeenCalled();
  });

  it('runs early artifact remediation without code-review stage transitions', async () => {
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product: baseProduct,
      prUrl: PR_URL,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(result.newStage).toBeUndefined();
    expect(transition).not.toHaveBeenCalled();
    expect(fanoutReviewers).toHaveBeenCalledWith(
      'issue_1',
      baseProduct,
      PR_URL,
      'token',
      expect.any(MockAgentRuntime),
      runGit,
      undefined,
      {
        fetchFn: undefined,
        selectedCodeRepo: { url: 'https://github.com/o/k', default_branch: 'main', role: 'docs' },
        selectedBranchName: 'helm/spec/issue_1',
        transformReviewComment: undefined,
      },
    );
    expect(buildRemediationParams).toHaveBeenCalledWith(
      'issue_1',
      baseProduct,
      '/tmp/ws',
      PR_URL,
      expect.any(Map),
      undefined,
      { url: 'https://github.com/o/k', default_branch: 'main', role: 'docs' },
      'helm/spec/issue_1',
      { catalogEntries: [] },
    );
  });

  it('returns early artifact remediation failures without transition or recovery attempts', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'error',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: false,
      pushed: false,
      error: 'remediation summary missing',
    });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product: baseProduct,
      prUrl: PR_URL,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result).toMatchObject({
      status: 'error',
      prUrl: PR_URL,
      error: 'remediation summary missing',
    });
    expect(result.newStage).toBeUndefined();
    expect(transition).not.toHaveBeenCalled();
    expect(buildRemediationParams).toHaveBeenCalledOnce();
    expect(handleRemediationResult).toHaveBeenCalledTimes(2);
  });

  it('escalates when max_cycles is reached before another remediation pass', async () => {
    const product: Product = {
      ...baseProduct,
      review: { loop: { max_cycles: 1, remediate_severity: 'critical_high' } },
    };
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

    const result = await runLoop(product);

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'max_cycles',
      cyclesCompleted: 1,
    });
    expect(result.error).toContain('max_cycles (1)');
    expect(transition).not.toHaveBeenCalled();
  });

  it('escalates after consecutive remediation cycles with no blocker reduction', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        loop: {
          max_cycles: 10,
          stop_rule: { no_progress_cycles: 2 },
          remediate_severity: 'critical_high',
        },
      },
    };
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

    const result = await runLoop(product);

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'no_progress',
      cyclesCompleted: 3,
    });
    expect(result.error).toContain('no progress on blocking findings');
    expect(fanoutReviewers).toHaveBeenCalledTimes(3);
    expect(transition).toHaveBeenCalledTimes(4);
  });

  describe('cumulative cross-dispatch budget (ADR-042)', () => {
    /** Mimics ItemStore.updateReviewLoopLedger for one lane. */
    const makeLedgerStore = () => {
      const calls: { lane: string; update: ReviewLoopLedgerUpdate }[] = [];
      let entry: ReviewLoopLedgerEntry | undefined;
      return {
        calls,
        get entry() {
          return entry;
        },
        persist: vi.fn(
          ({ lane, update }: { lane: string; update: ReviewLoopLedgerUpdate }): void => {
            calls.push({ lane, update });
            entry = { ...update, updatedAt: '2026-08-13T00:00:00.000Z' };
          },
        ),
      };
    };

    const budgetedProduct = (overrides: {
      max_cycles: number;
      max_cycles_cumulative?: number;
      no_progress_cycles?: number;
    }): Product => ({
      ...baseProduct,
      review: {
        loop: {
          max_cycles: overrides.max_cycles,
          ...(overrides.max_cycles_cumulative !== undefined
            ? { max_cycles_cumulative: overrides.max_cycles_cumulative }
            : {}),
          stop_rule: { no_progress_cycles: overrides.no_progress_cycles ?? 2 },
          remediate_severity: 'critical_high',
        },
      },
    });

    const runBudgetedLoop = (
      product: Product,
      store: ReturnType<typeof makeLedgerStore>,
      ledgerEntry?: ReviewLoopLedgerEntry,
    ) =>
      runCodeReviewLoop({
        externalId: 'issue_1',
        product,
        prUrl: PR_URL,
        codeRepo: product.code_repos[0]!,
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
        reviewLoopLedgerEntry: ledgerEntry,
        persistReviewLoopLedger: store.persist,
      });

    it('records a cumulative cycle on the code-review lane after each remediation pass', async () => {
      const store = makeLedgerStore();
      // Two remediation passes, then a clean fan-out ends the loop.
      vi.mocked(shouldRemediate)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

      const result = await runBudgetedLoop(budgetedProduct({ max_cycles: 10 }), store);

      expect(result.status).toBe('done');
      expect(store.calls).toEqual([
        {
          lane: 'code-review',
          update: { cyclesTotal: 1, noProgressStreak: 0, bestBlockerCount: 1 },
        },
        {
          lane: 'code-review',
          update: { cyclesTotal: 2, noProgressStreak: 1, bestBlockerCount: 1 },
        },
      ]);
    });

    it('does not touch the ledger when the loop is clean', async () => {
      const store = makeLedgerStore();
      vi.mocked(shouldRemediate).mockReturnValue(false);

      const result = await runBudgetedLoop(budgetedProduct({ max_cycles: 5 }), store);

      expect(result.status).toBe('done');
      expect(store.persist).not.toHaveBeenCalled();
    });

    it('escalates when a re-dispatch exhausts the lifetime budget', async () => {
      // The bug this closes: max_cycles alone lets each manual re-dispatch start
      // a fresh burst, so an item can never reach escalation.
      const product = budgetedProduct({
        max_cycles: 3,
        max_cycles_cumulative: 4,
        no_progress_cycles: 10,
      });
      const store = makeLedgerStore();
      vi.mocked(shouldRemediate).mockReturnValue(true);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

      const first = await runBudgetedLoop(product, store);
      expect(first).toMatchObject({
        status: 'error',
        escalated: true,
        escalationReason: 'max_cycles',
        cyclesCompleted: 3,
      });
      expect(store.entry?.cyclesTotal).toBe(2);

      // Manual re-dispatch: per-dispatch cycle restarts at 1, the ledger does not.
      const second = await runBudgetedLoop(product, store, store.entry);

      expect(second).toMatchObject({
        status: 'error',
        escalated: true,
        escalationReason: 'max_cycles_cumulative',
        cyclesCompleted: 2,
      });
      expect(second.error).toContain('max_cycles_cumulative=4');
      expect(store.entry?.escalationReason).toBe('max_cycles_cumulative');
      expect(store.entry?.escalatedAt).toBeDefined();
    });

    it('carries the no-progress streak across dispatches', async () => {
      const store = makeLedgerStore();
      vi.mocked(shouldRemediate).mockReturnValue(true);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

      const result = await runBudgetedLoop(
        budgetedProduct({ max_cycles: 10, no_progress_cycles: 2 }),
        store,
        {
          cyclesTotal: 4,
          noProgressStreak: 1,
          bestBlockerCount: 1,
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      );

      // Streak 1 (carried) + this flat cycle = 2 → escalates on the first cycle
      // of the new dispatch instead of restarting the count.
      expect(result).toMatchObject({
        status: 'error',
        escalated: true,
        escalationReason: 'no_progress',
        cyclesCompleted: 1,
      });
      expect(result.error).toContain('spans dispatches');
      expect(store.entry?.escalationReason).toBe('no_progress');
    });

    it('posts the escalation comment on the PR for internal stop-rule exits', async () => {
      const store = makeLedgerStore();
      vi.mocked(shouldRemediate).mockReturnValue(true);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

      await runBudgetedLoop(budgetedProduct({ max_cycles: 1 }), store);

      expect(postPRComment).toHaveBeenCalledWith(
        expect.objectContaining({
          prUrl: PR_URL,
          body: expect.stringContaining('`max_cycles`'),
        }),
        undefined,
      );
    });

    it('keeps draft-artifact loops on their own lane', async () => {
      const store = makeLedgerStore();
      vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValue(false);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

      await runEarlyArtifactReviewLoop({
        kind: 'plan',
        externalId: 'issue_1',
        product: budgetedProduct({ max_cycles: 5 }),
        prUrl: PR_URL,
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
        persistReviewLoopLedger: store.persist,
      });

      expect(store.calls.map((call) => call.lane)).toEqual(['plan-draft']);
    });

    it('survives a ledger write failure without failing the loop', async () => {
      vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValue(false);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await runCodeReviewLoop({
        externalId: 'issue_1',
        product: budgetedProduct({ max_cycles: 5 }),
        prUrl: PR_URL,
        codeRepo: baseProduct.code_repos[0]!,
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
        persistReviewLoopLedger: vi.fn().mockRejectedValue(new Error('disk full')),
      });

      expect(result.status).toBe('done');
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  it('returns error when fan-out fails with zero reviewer results', async () => {
    vi.mocked(fanoutReviewers).mockResolvedValue({
      reviewerResults: [],
      prUrl: PR_URL,
      status: 'error',
      costUsd: 0,
      durationMs: 10,
      error: 'all reviewers failed',
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      error: 'all reviewers failed',
    });
  });

  it('returns error when transition to remediation fails after provisioning', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    transition.mockRejectedValueOnce(new Error('transition boom'));

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'code-review',
    });
    expect(result.error).toContain('Failed to transition to remediation');
  });

  it('returns error when remediation fails to push patches and recovers to code-review', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'error',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: false,
      pushed: false,
      error: 'push failed',
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'code-review',
      error: 'push failed',
    });
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStage: 'code-review',
        triggeredBy: 'specialist:remediation-recovery',
      }),
    );
  });

  it('succeeds when remediation succeeds on retry without redundant code-review transition', async () => {
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));
    vi.mocked(handleRemediationResult)
      .mockResolvedValueOnce({
        status: 'error',
        costUsd: 0.02,
        durationMs: 200,
        commentPosted: false,
        pushed: false,
        error: 'push failed',
      })
      .mockResolvedValueOnce({
        status: 'done',
        costUsd: 0.02,
        durationMs: 200,
        commentPosted: true,
        pushed: true,
        commitSha: 'sha789',
      });
    transition.mockImplementation(async (input) => {
      if (input.toStage === 'code-review' && input.triggeredBy === 'specialist:remediation') {
        throw new Error('self-transition not allowed');
      }
      return { currentStage: input.toStage };
    });

    const result = await runLoop();

    expect(result.status).toBe('done');
    expect(transition).not.toHaveBeenCalledWith(
      expect.objectContaining({
        toStage: 'code-review',
        triggeredBy: 'specialist:remediation',
      }),
    );
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredBy: 'specialist:remediation-recovery',
      }),
    );
  });

  it('returns augmented error when remediation fails and recovery transition fails', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'error',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: false,
      pushed: false,
      error: 'push failed',
    });
    transition.mockImplementation(async (input) => {
      if (input.triggeredBy === 'specialist:remediation-recovery') {
        throw new Error('recovery failed');
      }
      return { currentStage: input.toStage };
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'remediation',
    });
    expect(result.error).toContain('push failed');
    expect(result.error).toContain('remediation-recovery also failed');
  });

  it('returns error when reviewer workspace provisioning fails', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(provisionReviewerWorkspace).mockRejectedValueOnce(new Error('clone failed'));

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'code-review',
    });
    expect(result.error).toContain('Failed to provision remediation workspace');
    expect(result.error).toContain('clone failed');
    expect(transition).not.toHaveBeenCalled();
  });

  it('preserves stage when early artifact remediation provisioning fails', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(provisionReviewerWorkspace).mockRejectedValueOnce(new Error('clone failed'));

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product: baseProduct,
      prUrl: PR_URL,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
    });
    expect(result.newStage).toBeUndefined();
    expect(result.error).toContain('Failed to provision remediation workspace');
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns error when transition back to code-review fails after remediation', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    transition.mockImplementation(async (input) => {
      if (input.toStage === 'code-review' && input.triggeredBy === 'specialist:remediation') {
        throw new Error('back transition boom');
      }
      if (input.triggeredBy === 'specialist:remediation-recovery') {
        throw new Error('recovery also failed');
      }
      return { currentStage: input.toStage };
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'remediation',
    });
    expect(result.error).toContain('Failed to transition back to code-review');
    expect(result.error).toContain('remediation-recovery also failed');
    expect(transition).toHaveBeenCalledTimes(3);
  });

  it('returns error when fan-out errored after remediation completes', async () => {
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(
        makeFanout({ status: 'error', error: 'partial reviewer coverage' }, undefined),
      );

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 2,
      newStage: 'code-review',
    });
    expect(result.error).toContain('Reviewer fan-out reported an error');
    expect(result.error).toContain('partial reviewer coverage');
  });

  it('returns error when fan-out errored during the remediation pass', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(
      makeFanout({ status: 'error', error: 'partial reviewer coverage' }),
    );

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'code-review',
    });
    expect(result.error).toContain(
      'Remediation succeeded, but the reviewer fan-out reported an error',
    );
  });

  it('escalates when external review reports escalate', async () => {
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'escalate',
      reason: 'coderabbit pending_timeout',
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'external_escalate',
      cyclesCompleted: 1,
    });
    expect(result.error).toContain('coderabbit pending_timeout');
    expect(postPRComment).toHaveBeenCalledTimes(1);
  });

  it('defers analysis-pending external review without posting escalation', async () => {
    const product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'coderabbit',
          max_defer_sec: 600,
        },
      },
    } as Product;
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'pending_timeout',
    });
    const onExternalReviewDeferred = vi.fn();

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      targetRevision: 'sha-42',
      onExternalReviewDeferred,
    });

    expect(result).toMatchObject({
      status: 'deferred',
      cyclesCompleted: 1,
      deferredExternalReview: {
        productSlug: 'test',
        externalId: 'issue_1',
        specialistId: 'reviewer-fanout',
        provider: 'coderabbit',
        reason: 'analysis_pending',
        providerReason: 'pending_timeout',
        prNumber: 42,
        targetRevision: 'sha-42',
        maxDeferSec: 600,
      },
    });
    expect(onExternalReviewDeferred).toHaveBeenCalledWith(result.deferredExternalReview);
    expect(postPRComment).not.toHaveBeenCalled();
  });

  it('fails deferred external review when the target revision is missing', async () => {
    const product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'coderabbit',
          max_defer_sec: 600,
        },
      },
    } as Product;
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'deferred',
      reason: 'analysis_pending',
    });
    const onExternalReviewDeferred = vi.fn();

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      onExternalReviewDeferred,
    });

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      error: 'External review deferred but target revision was not recorded',
    });
    expect(onExternalReviewDeferred).not.toHaveBeenCalled();
  });

  it('fails deferred external review when intent persistence fails', async () => {
    const product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'coderabbit',
          max_defer_sec: 600,
        },
      },
    } as Product;
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'deferred',
      reason: 'analysis_pending',
    });
    const onExternalReviewDeferred = vi.fn().mockRejectedValue(new Error('outbox unavailable'));

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      targetRevision: 'sha-42',
      onExternalReviewDeferred,
    });

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      error: 'External review deferred but intent persistence failed: outbox unavailable',
    });
    expect(onExternalReviewDeferred).toHaveBeenCalledTimes(1);
  });

  it('persists the draft reviewer identity when early artifact review defers', async () => {
    const product = {
      ...baseProduct,
      review: {
        early_loop: { enabled: true },
        external: {
          provider: 'coderabbit',
          max_defer_sec: 600,
        },
      },
    } as Product;
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'pending_timeout',
    });
    const onExternalReviewDeferred = vi.fn();

    const result = await runEarlyArtifactReviewLoop({
      kind: 'plan',
      externalId: 'issue_1',
      product,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      targetRevision: 'sha-42',
      onExternalReviewDeferred,
    });

    expect(result).toMatchObject({
      status: 'deferred',
      deferredExternalReview: {
        productSlug: 'test',
        externalId: 'issue_1',
        specialistId: 'plan-draft-reviewer',
        provider: 'coderabbit',
        reason: 'analysis_pending',
        prNumber: 7,
        targetRevision: 'sha-42',
      },
    });
    expect(onExternalReviewDeferred).toHaveBeenCalledWith(result.deferredExternalReview);
  });

  it('escalates after repeated external skips', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'coderabbit',
        },
        loop: {
          max_cycles: 5,
          stop_rule: { no_progress_cycles: 2 },
          remediate_severity: 'critical_high',
        },
      },
    };
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'skipped',
      reason: 'unavailable',
    });
    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'external_repeated_skip',
    });
    expect(runExternalReviewIfConfigured).toHaveBeenCalledTimes(2);
  });

  it('remediates external needs_fixes and re-runs internal fanout instead of returning done', async () => {
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(
        makeFanout({
          reviewerResults: [
            {
              kind: 'code',
              status: 'done',
              costUsd: 0.01,
              durationMs: 50,
              commentPosted: true,
              findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
              commentBody: 'fix this',
            },
            {
              kind: 'security',
              status: 'done',
              costUsd: 0.01,
              durationMs: 50,
              commentPosted: true,
              findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
              commentBody: 'SQL injection risk',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));

    vi.mocked(runExternalReviewIfConfigured)
      .mockResolvedValueOnce({
        status: 'needs_fixes',
        blockers: [
          {
            id: 'ext-1',
            severity: 'high',
            blocking: true,
            summary: 'External blocker',
            path: 'src/a.ts',
          },
        ],
        advisories: [],
      })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'not_configured' });

    const result = await runLoop();

    expect(result.status).toBe('done');
    expect(fanoutReviewers).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(buildRemediationParams).toHaveBeenCalledWith(
      'issue_1',
      baseProduct,
      '/tmp/ws',
      PR_URL,
      expect.any(Map),
      undefined,
      baseProduct.code_repos[0],
      undefined,
      { catalogEntries: [] },
    );
    const findingsByKind = vi.mocked(buildRemediationParams).mock.calls.at(-1)![4] as Map<
      string,
      string
    >;
    expect(findingsByKind.get('code')).toContain('External blocker');
    expect(findingsByKind.get('code')).toContain('src/a.ts');
    expect(findingsByKind.get('code')).toContain('fix this');
    expect(findingsByKind.get('security')).toBe('SQL injection risk');
  });

  it('returns error when external needs_fixes remediation fails', async () => {
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'needs_fixes',
      blockers: [{ id: 'ext-1', severity: 'high', blocking: true, summary: 'External blocker' }],
      advisories: [],
    });
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'error',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: false,
      pushed: false,
      error: 'external remediation failed',
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'code-review',
      error: 'external remediation failed',
    });
  });

  it('posts Review Loop Summary on clean exit with external advisories', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'coderabbit',
        },
      },
    };
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'clean',
      blockers: [],
      advisories: [
        {
          id: 'adv-1',
          severity: 'low',
          blocking: false,
          summary: 'Weak test coverage on summary module',
        },
      ],
    });

    const result = await runLoop(product);

    expect(result.status).toBe('done');
    expect(upsertReviewLoopSummaryComment).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: PR_URL,
        cyclesCompleted: 1,
        externalProvider: 'coderabbit',
        stage: 'code-review',
        advisories: expect.arrayContaining([
          expect.objectContaining({ id: 'adv-1', summary: 'Weak test coverage on summary module' }),
        ]),
      }),
    );
  });

  it('routes early artifact advisories through draft-stage false-positive disposition', async () => {
    const builtInCatalog = builtInFalsePositiveEntries();
    const product: Product = {
      ...baseProduct,
      review: {
        early_loop: { enabled: true },
        external: {
          provider: 'coderabbit',
        },
      },
    };
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInCatalog);
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'clean',
      blockers: [],
      advisories: [
        {
          id: 'adv-sequential',
          severity: 'low',
          blocking: false,
          summary: 'pair-spec-and-plan-files',
        },
      ],
    });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(fanoutReviewers).toHaveBeenCalledWith(
      'issue_1',
      product,
      'https://github.com/o/k/pull/7',
      'token',
      expect.any(MockAgentRuntime),
      runGit,
      undefined,
      {
        fetchFn: undefined,
        selectedCodeRepo: { url: 'https://github.com/o/k', default_branch: 'main', role: 'docs' },
        selectedBranchName: 'helm/spec/issue_1',
        transformReviewComment: expect.any(Function),
      },
    );
    expect(upsertReviewLoopSummaryComment).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: 'https://github.com/o/k/pull/7',
        stage: 'spec-draft',
        catalog: builtInCatalog,
        advisories: [
          expect.objectContaining({
            id: 'adv-sequential',
            summary: 'pair-spec-and-plan-files',
          }),
        ],
      }),
    );
    const summaryInput = vi.mocked(upsertReviewLoopSummaryComment).mock.calls.at(-1)![0];
    expect(summaryInput).toEqual(
      expect.objectContaining({
        cyclesCompleted: 1,
        externalProvider: 'coderabbit',
        stage: 'spec-draft',
        advisories: [
          expect.objectContaining({
            id: 'adv-sequential',
            severity: 'low',
            blocking: false,
            summary: 'pair-spec-and-plan-files',
          }),
        ],
        catalog: expect.arrayContaining([
          expect.objectContaining({
            pattern: 'pair-spec-and-plan-files',
            appliesTo: ['spec-draft', 'plan-draft'],
          }),
        ]),
      }),
    );
    expect(
      buildAdvisorySummaryRows(
        summaryInput.advisories,
        summaryInput.catalog,
        summaryInput.stage,
      )[0],
    ).toMatchObject({
      disposition: 'Rejected',
      rationale:
        'Draft artifact review may see only one side of the spec/plan pair before the operator merges the current artifact PR.',
    });
  });

  it('routes plan-draft advisories through draft-stage false-positive disposition', async () => {
    const builtInCatalog = builtInFalsePositiveEntries();
    const product: Product = {
      ...baseProduct,
      review: {
        early_loop: { enabled: true },
        external: {
          provider: 'coderabbit',
        },
      },
    };
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInCatalog);
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'clean',
      blockers: [],
      advisories: [
        {
          id: 'adv-sequential',
          severity: 'low',
          blocking: false,
          summary: 'pair-spec-and-plan-files',
        },
      ],
    });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'plan',
      externalId: 'issue_1',
      product,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(upsertReviewLoopSummaryComment).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: 'https://github.com/o/k/pull/7',
        stage: 'plan-draft',
        catalog: builtInCatalog,
        advisories: [
          expect.objectContaining({
            id: 'adv-sequential',
            summary: 'pair-spec-and-plan-files',
          }),
        ],
      }),
    );
  });

  it.each([
    { kind: 'spec' as const, stage: 'spec-draft' as const, path: 'specs/issue_1.md' },
    { kind: 'plan' as const, stage: 'plan-draft' as const, path: 'plans/issue_1.md' },
  ])(
    'suppresses pair-spec-and-plan-files through the real fetched catalog merge for $stage',
    async ({ kind, stage, path }) => {
      const actualFalsePositives =
        await vi.importActual<typeof import('./false-positives.js')>('./false-positives.js');
      vi.mocked(fetchFalsePositivesCatalog).mockImplementation(
        actualFalsePositives.fetchFalsePositivesCatalog,
      );
      const fetchFn = vi.fn(async () => {
        return new Response(
          [
            '# Code-review false positives',
            '',
            '---',
            '',
            '## Remote-only pattern',
            '',
            '**Pattern:** remote-only-pattern',
            '',
            '**Applies to:** code-review',
            '',
            "**Why it's a false positive:** Remote catalog entries are merged with built-ins.",
            '',
          ].join('\n'),
          { status: 200 },
        );
      }) as typeof fetch;
      const product: Product = {
        ...baseProduct,
        review: {
          early_loop: { enabled: true },
          external: {
            provider: 'coderabbit',
          },
        },
      };
      vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
        status: 'needs_fixes',
        blockers: [
          {
            id: `adv-pair-${kind}`,
            severity: 'high',
            blocking: true,
            summary: 'pair-spec-and-plan-files sequencing',
            path,
          },
        ],
        advisories: [],
      });

      const result = await runEarlyArtifactReviewLoop({
        kind,
        externalId: 'issue_1',
        product,
        prUrl: 'https://github.com/o/k/pull/7',
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
        fetchFn,
      });

      expect(result.status).toBe('done');
      expect(fetchFn).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/o/k/main/false-positives.md',
        { headers: { Authorization: 'Bearer token' } },
      );
      expect(buildRemediationParams).not.toHaveBeenCalled();
      expect(handleRemediationResult).not.toHaveBeenCalled();
      expect(upsertReviewLoopSummaryComment).toHaveBeenCalledWith(
        expect.objectContaining({
          prUrl: 'https://github.com/o/k/pull/7',
          stage,
          advisories: [
            expect.objectContaining({
              id: `adv-pair-${kind}`,
              summary: 'pair-spec-and-plan-files sequencing',
              blocking: false,
            }),
          ],
          catalog: expect.arrayContaining([
            expect.objectContaining({
              pattern: 'pair-spec-and-plan-files',
              appliesTo: ['spec-draft', 'plan-draft'],
              source: 'built-in',
            }),
            expect.objectContaining({
              pattern: 'remote-only-pattern',
              source: 'remote',
            }),
          ]),
        }),
      );
    },
  );

  it.each([
    {
      kind: 'spec' as const,
      summary: 'plan file is missing while spec remains in spec-draft',
    },
    {
      kind: 'plan' as const,
      summary: 'pair-spec-and-plan-files sequencing',
    },
    {
      kind: 'plan' as const,
      summary: 'spec file is missing while plan remains in plan-draft',
    },
  ])(
    'suppresses sequential $kind-draft reviewer findings before remediation',
    async ({ kind, summary }) => {
      const builtInCatalog = builtInFalsePositiveEntries();
      vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInCatalog);
      vi.mocked(fanoutReviewers).mockResolvedValue(
        makeFanout(
          {
            prUrl: 'https://github.com/o/k/pull/7',
            reviewerResults: [
              {
                kind: 'code',
                status: 'done',
                costUsd: 0.01,
                durationMs: 50,
                commentPosted: true,
                findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
                commentBody: `# Code Review\n\n## Findings\n- **HIGH** · ${summary}\n\n## Status\nCHANGES_REQUESTED`,
              },
            ],
          },
          undefined,
        ),
      );
      vi.mocked(shouldRemediate).mockImplementation((results) =>
        results.some(
          (result) =>
            result.findings !== undefined &&
            result.findings.critical + result.findings.high + result.findings.medium > 0,
        ),
      );

      const result = await runEarlyArtifactReviewLoop({
        kind,
        externalId: 'issue_1',
        product: baseProduct,
        prUrl: 'https://github.com/o/k/pull/7',
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
      });

      expect(result.status).toBe('done');
      expect(shouldRemediate).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            findings: { critical: 0, high: 0, medium: 0, low: 0, info: 1 },
            commentBody: expect.stringContaining('Catalogued false positive'),
          }),
        ],
        'critical_high',
      );
      expect(buildRemediationParams).not.toHaveBeenCalled();
      expect(handleRemediationResult).not.toHaveBeenCalled();
    },
  );

  it('rewrites early artifact review status after suppressing catalogued findings', async () => {
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInFalsePositiveEntries());
    let transformedBody = '';
    vi.mocked(fanoutReviewers).mockImplementationOnce(async (...args) => {
      const transformReviewComment = args[7]?.transformReviewComment;
      expect(transformReviewComment).toBeTypeOf('function');
      const transformed = await transformReviewComment!({
        kind: 'code',
        reviewContent: [
          '# Code Review',
          '',
          '## Findings',
          '- **HIGH** · pair-spec-and-plan-files sequencing',
          '',
          '## Status',
          'CHANGES_REQUESTED',
        ].join('\n'),
        findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      });
      transformedBody = transformed.reviewContent;
      return makeFanout(
        {
          prUrl: 'https://github.com/o/k/pull/7',
          reviewerResults: [
            {
              kind: 'code',
              status: 'done',
              costUsd: 0.01,
              durationMs: 50,
              commentPosted: true,
              findings: transformed.findings,
              commentBody: transformed.reviewContent,
            },
          ],
        },
        undefined,
      );
    });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product: baseProduct,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(transformedBody).toContain('**INFO** · Catalogued false positive');
    expect(transformedBody).toContain('## Status\nAPPROVED');
    expect(transformedBody).not.toContain('## Status\nCHANGES_REQUESTED');
    expect(shouldRemediate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          findings: { critical: 0, high: 0, medium: 0, low: 0, info: 1 },
          commentBody: expect.stringContaining('## Status\nAPPROVED'),
        }),
      ],
      'critical_high',
    );
  });

  it('does not rewrite early-artifact status when no catalog entry matches', async () => {
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInFalsePositiveEntries());
    let transformedBody = '';
    vi.mocked(fanoutReviewers).mockImplementationOnce(async (...args) => {
      const transformReviewComment = args[7]?.transformReviewComment;
      expect(transformReviewComment).toBeTypeOf('function');
      const transformed = await transformReviewComment!({
        kind: 'code',
        reviewContent: [
          '# Code Review',
          '',
          '## Findings',
          '- **HIGH** · totally novel domain finding',
          '',
          '## Status',
          'CHANGES_REQUESTED',
        ].join('\n'),
        // Counts already zero (e.g. only info-level findings were tallied upstream)
        // yet Status still says CHANGES_REQUESTED — must not flip to APPROVED.
        findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      });
      transformedBody = transformed.reviewContent;
      return makeFanout(
        {
          prUrl: 'https://github.com/o/k/pull/7',
          reviewerResults: [
            {
              kind: 'code',
              status: 'done',
              costUsd: 0.01,
              durationMs: 50,
              commentPosted: true,
              findings: transformed.findings,
              commentBody: transformed.reviewContent,
            },
          ],
        },
        undefined,
      );
    });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product: baseProduct,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(transformedBody).toContain('- **HIGH** · totally novel domain finding');
    expect(transformedBody).toContain('## Status\nCHANGES_REQUESTED');
    expect(transformedBody).not.toContain('## Status\nAPPROVED');
    expect(transformedBody).not.toContain('Catalogued false positive');
  });

  it('still remediates a sequential-artifact-looking reviewer finding in code-review mode', async () => {
    const builtInCatalog = builtInFalsePositiveEntries();
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInCatalog);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(
        makeFanout(
          {
            reviewerResults: [
              {
                kind: 'code',
                status: 'done',
                costUsd: 0.01,
                durationMs: 50,
                commentPosted: true,
                findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
                commentBody:
                  '# Code Review\n\n## Findings\n- **HIGH** · pair-spec-and-plan-files sequencing\n\n## Status\nCHANGES_REQUESTED',
              },
            ],
          },
          undefined,
        ),
      )
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));
    vi.mocked(shouldRemediate).mockImplementation((results) =>
      results.some(
        (result) =>
          result.findings !== undefined &&
          result.findings.critical + result.findings.high + result.findings.medium > 0,
      ),
    );

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product: baseProduct,
      prUrl: PR_URL,
      codeRepo: baseProduct.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(shouldRemediate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          commentBody: expect.stringContaining('**HIGH** · pair-spec-and-plan-files sequencing'),
        }),
      ],
      'critical_high',
    );
    expect(buildRemediationParams).toHaveBeenCalled();
    const findingsByKind = vi.mocked(buildRemediationParams).mock.calls[0]![4] as Map<
      string,
      string
    >;
    expect(findingsByKind.get('code')).toContain('pair-spec-and-plan-files sequencing');
  });

  it.each([
    {
      kind: 'spec' as const,
      id: 'adv-plan-missing',
      summary: 'plan file is missing while spec remains in spec-draft',
    },
    {
      kind: 'plan' as const,
      id: 'adv-pair-sequencing',
      summary: 'pair-spec-and-plan-files sequencing',
    },
    {
      kind: 'plan' as const,
      id: 'adv-spec-missing',
      summary: 'spec file is missing while plan remains in plan-draft',
    },
  ])(
    'suppresses sequential $kind-draft external blockers before remediation',
    async ({ kind, id, summary }) => {
      const builtInCatalog = builtInFalsePositiveEntries();
      const product: Product = {
        ...baseProduct,
        review: {
          early_loop: { enabled: true },
          external: {
            provider: 'coderabbit',
          },
        },
      };
      vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInCatalog);
      vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
        status: 'needs_fixes',
        blockers: [
          {
            id,
            severity: 'high',
            blocking: true,
            summary,
            path: kind === 'spec' ? 'specs/issue_1.md' : 'plans/issue_1.md',
          },
        ],
        advisories: [],
      });

      const result = await runEarlyArtifactReviewLoop({
        kind,
        externalId: 'issue_1',
        product,
        prUrl: 'https://github.com/o/k/pull/7',
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
      });

      expect(result.status).toBe('done');
      expect(buildRemediationParams).not.toHaveBeenCalled();
      expect(handleRemediationResult).not.toHaveBeenCalled();
      expect(upsertReviewLoopSummaryComment).toHaveBeenCalledWith(
        expect.objectContaining({
          prUrl: 'https://github.com/o/k/pull/7',
          stage: kind === 'spec' ? 'spec-draft' : 'plan-draft',
          catalog: builtInCatalog,
          advisories: [
            expect.objectContaining({
              id,
              summary,
              blocking: false,
            }),
          ],
        }),
      );
    },
  );

  it('returns error when fan-out errored and external blockers are all suppressed', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        early_loop: { enabled: true },
        external: {
          provider: 'coderabbit',
        },
      },
    };
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInFalsePositiveEntries());
    vi.mocked(fanoutReviewers).mockResolvedValue(
      makeFanout(
        { status: 'error', error: 'security reviewer comment failed' },
        { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      ),
    );
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'needs_fixes',
      blockers: [
        {
          id: 'adv-plan-missing',
          severity: 'high',
          blocking: true,
          summary: 'plan file is missing while spec remains in spec-draft',
          path: 'specs/issue_1.md',
        },
      ],
      advisories: [],
    });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Reviewer fan-out reported an error');
    expect(result.error).toContain('security reviewer comment failed');
  });

  it('remediates genuine external blockers when catalogued false positives coexist', async () => {
    const builtInCatalog = builtInFalsePositiveEntries();
    const product: Product = {
      ...baseProduct,
      review: {
        early_loop: { enabled: true },
        external: {
          provider: 'coderabbit',
        },
      },
    };
    vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInCatalog);
    vi.mocked(runExternalReviewIfConfigured)
      .mockResolvedValueOnce({
        status: 'needs_fixes',
        blockers: [
          {
            id: 'adv-plan-missing',
            severity: 'high',
            blocking: true,
            summary: 'plan file is missing while spec remains in spec-draft',
            path: 'specs/issue_1.md',
          },
          {
            id: 'real-blocker',
            severity: 'high',
            blocking: true,
            summary: 'Spec omits the webhook persistence guard',
            path: 'specs/issue_1.md',
          },
        ],
        advisories: [],
      })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'not_configured' });

    const result = await runEarlyArtifactReviewLoop({
      kind: 'spec',
      externalId: 'issue_1',
      product,
      prUrl: 'https://github.com/o/k/pull/7',
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(buildRemediationParams).toHaveBeenCalled();
    expect(handleRemediationResult).toHaveBeenCalled();
    const findingsByKind = vi.mocked(buildRemediationParams).mock.calls.at(-1)![4] as Map<
      string,
      string
    >;
    expect(findingsByKind.get('code')).toContain('Spec omits the webhook persistence guard');
    expect(findingsByKind.get('code')).not.toContain(
      'plan file is missing while spec remains in spec-draft',
    );
  });

  it('escalates when review-adjudicator requires human input (ADR-037)', async () => {
    const product: Product = {
      ...baseProduct,
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.01,
      durationMs: 100,
      commentPosted: true,
      parsed: {
        status: 'HUMAN_REQUIRED',
        unifiedPlan: '',
        body: '# Review Adjudication\n\n## Status\nHUMAN_REQUIRED',
        conflictsSection: '- **product_decision** · Vacancy semantics',
        conflicts: [
          {
            conflictKind: 'product_decision',
            conflictTitle: 'Vacancy semantics',
            scope: { paths: [], markers: [] },
            fingerprint: 'kind=product_decision|title=vacancy semantics|paths=|markers=',
            body: '- **product_decision** · Vacancy semantics',
          },
        ],
      },
    });

    const result = await runLoop(product);

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'adjudication_conflict',
    });
    expect(buildRemediationParams).not.toHaveBeenCalled();
    expect(postPRComment).toHaveBeenCalled();
  });

  it('uses stored product decisions instead of re-escalating the same conflict', async () => {
    const product: Product = {
      ...baseProduct,
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));
    vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.01,
      durationMs: 100,
      commentPosted: true,
      // handleReviewAdjudicatorResult suppresses settled conflicts before return.
      parsed: {
        status: 'AUTO_REMEDIATE',
        unifiedPlan:
          '- **DEFERRED** · Vacancy semantics — awaiting human decision\n- **SETTLED** · Vacancy semantics — using recorded choice: Option A',
        body: '# Review Adjudication\n\n## Status\nAUTO_REMEDIATE',
        conflictsSection: '',
        conflicts: [],
      },
    });

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      resolvedProductDecisions: [
        {
          fingerprint: 'kind=product_decision|title=vacancy semantics|paths=|markers=',
          conflictKind: 'product_decision',
          conflictTitle: 'Vacancy semantics',
          scope: { paths: [], markers: [] },
          chosenOption: 'Option A',
          recordedAt: '2026-07-22T12:00:00.000Z',
          source: {
            provider: 'github',
            owner: 'o',
            repo: 'r',
            prNumber: 42,
            authorLogin: 'maintainer',
          },
        },
      ],
    });

    expect(result.status).toBe('done');
    expect(result.escalated).toBeUndefined();
    expect(handleReviewAdjudicatorResult).toHaveBeenCalledWith(
      'issue_1',
      expect.anything(),
      expect.any(String),
      PR_URL,
      'token',
      undefined,
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: 'kind=product_decision|title=vacancy semantics|paths=|markers=',
        }),
      ]),
    );
    expect(buildRemediationParams).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.any(Map),
      expect.stringContaining('SETTLED'),
      expect.any(Object),
      undefined,
      { catalogEntries: [] },
    );
  });

  it('reloads settled decisions via loadResolvedProductDecisions before adjudication', async () => {
    const product: Product = {
      ...baseProduct,
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));
    vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.01,
      durationMs: 100,
      commentPosted: true,
      parsed: {
        status: 'AUTO_REMEDIATE',
        unifiedPlan: '- **SETTLED** · Vacancy semantics — using recorded choice: Option A',
        body: '# Review Adjudication\n\n## Status\nAUTO_REMEDIATE',
        conflictsSection: '',
        conflicts: [],
      },
    });

    const liveDecision = {
      fingerprint: 'kind=product_decision|title=vacancy semantics|paths=|markers=',
      conflictKind: 'product_decision' as const,
      conflictTitle: 'Vacancy semantics',
      scope: { paths: [] as string[], markers: [] as string[] },
      chosenOption: 'Option A',
      recordedAt: '2026-07-22T12:00:00.000Z',
      source: {
        provider: 'github' as const,
        owner: 'o',
        repo: 'r',
        prNumber: 42,
        authorLogin: 'maintainer',
      },
    };
    const loadResolvedProductDecisions = vi.fn().mockResolvedValue([liveDecision]);

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      // Stale/empty snapshot at job start — live loader supplies the decision.
      resolvedProductDecisions: [],
      loadResolvedProductDecisions,
    });

    expect(result.status).toBe('done');
    expect(loadResolvedProductDecisions).toHaveBeenCalled();
    expect(handleReviewAdjudicatorResult).toHaveBeenCalledWith(
      'issue_1',
      expect.anything(),
      expect.any(String),
      PR_URL,
      'token',
      undefined,
      [liveDecision],
    );
  });

  it('fails closed when loadResolvedProductDecisions throws instead of using a stale snapshot', async () => {
    const product: Product = {
      ...baseProduct,
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

    const result = await runCodeReviewLoop({
      externalId: 'issue_1',
      product,
      prUrl: PR_URL,
      codeRepo: product.code_repos[0]!,
      githubToken: 'token',
      runtime: new MockAgentRuntime({ messages: [] }),
      transition: transition as ItemTransitionFn,
      runGit,
      resolvedProductDecisions: [
        {
          fingerprint: 'kind=product_decision|title=stale|paths=|markers=',
          conflictKind: 'product_decision',
          conflictTitle: 'Stale',
          scope: { paths: [], markers: [] },
          chosenOption: 'Option A',
          recordedAt: '2026-07-22T12:00:00.000Z',
          source: {
            provider: 'github',
            owner: 'o',
            repo: 'r',
            prNumber: 42,
            authorLogin: 'maintainer',
          },
        },
      ],
      loadResolvedProductDecisions: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('Failed to reload settled product decisions');
    expect(result.error).not.toContain('disk read failed');
    expect(handleReviewAdjudicatorResult).not.toHaveBeenCalled();
  });

  it('passes unified adjudication plan to code-remediator on AUTO_REMEDIATE (ADR-037)', async () => {
    const product: Product = {
      ...baseProduct,
      specialists: {
        ...baseProduct.specialists,
        'review-adjudicator': { runtime: 'claude_code', model: 'm' },
      },
    };
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));
    vi.mocked(buildReviewAdjudicatorParams).mockReturnValue({
      specialistId: 'review-adjudicator',
      prompt: 'adjudicate',
      workdir: '/tmp/ws',
      productSlug: 'test',
      externalId: 'issue_1',
      permissionMode: 'acceptEdits',
      timeoutMs: 1000,
    });
    vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.01,
      durationMs: 100,
      commentPosted: true,
      parsed: {
        status: 'AUTO_REMEDIATE',
        unifiedPlan: '- **AUTO** · Add CSRF guard on POST /api/sync',
        body: '# Review Adjudication\n\n## Status\nAUTO_REMEDIATE',
        conflictsSection: '',
        conflicts: [],
      },
    });

    const result = await runLoop(product);

    expect(result.status).toBe('done');
    expect(buildRemediationParams).toHaveBeenCalledWith(
      'issue_1',
      product,
      '/tmp/ws',
      PR_URL,
      expect.any(Map),
      '- **AUTO** · Add CSRF guard on POST /api/sync',
      product.code_repos[0],
      undefined,
      { catalogEntries: [] },
    );
  });

  const productWithAdjudicator = (): Product => ({
    ...baseProduct,
    specialists: {
      ...baseProduct.specialists,
      'review-adjudicator': { runtime: 'claude_code', model: 'm' },
    },
  });

  it('skips runAdjudicationPass when review-adjudicator is not configured', async () => {
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));

    const result = await runLoop();

    expect(result.status).toBe('done');
    expect(handleReviewAdjudicatorResult).not.toHaveBeenCalled();
  });

  it('surfaces adjudicator failures from runAdjudicationPass', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(buildReviewAdjudicatorParams).mockReturnValue({
      specialistId: 'review-adjudicator',
      prompt: 'adjudicate',
      workdir: '/tmp/ws',
      productSlug: 'test',
      externalId: 'issue_1',
      permissionMode: 'acceptEdits',
      timeoutMs: 1000,
    });
    vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
      status: 'error',
      costUsd: 0,
      durationMs: 1,
      commentPosted: false,
      error: 'Agent failed',
    });

    const result = await runLoop(productWithAdjudicator());

    expect(result.status).toBe('error');
    expect(result.error).toContain('Agent failed');
  });

  it('continues adjudication when fetchSpecForPlan fails with ENOENT', async () => {
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fanoutReviewers)
      .mockResolvedValueOnce(makeFanout())
      .mockResolvedValueOnce(makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }));
    vi.mocked(fetchSpecForPlan).mockRejectedValue(
      Object.assign(new Error('missing spec'), { code: 'ENOENT' }),
    );
    vi.mocked(buildReviewAdjudicatorParams).mockReturnValue({
      specialistId: 'review-adjudicator',
      prompt: 'adjudicate',
      workdir: '/tmp/ws',
      productSlug: 'test',
      externalId: 'issue_1',
      permissionMode: 'acceptEdits',
      timeoutMs: 1000,
    });
    vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
      status: 'done',
      costUsd: 0,
      durationMs: 1,
      commentPosted: true,
      parsed: {
        status: 'AUTO_REMEDIATE',
        unifiedPlan: '- **AUTO** · Fix',
        body: '# Review Adjudication\n\n## Status\nAUTO_REMEDIATE',
        conflictsSection: '',
        conflicts: [],
      },
    });

    const result = await runLoop(productWithAdjudicator());

    expect(result.status).toBe('done');
    expect(buildReviewAdjudicatorParams).toHaveBeenCalledWith(
      'issue_1',
      expect.anything(),
      '/tmp/ws',
      PR_URL,
      expect.any(Map),
      {
        spec: undefined,
        resolvedProductDecisions: [],
        catalogEntries: [],
        codeRepo: productWithAdjudicator().code_repos[0],
        branchName: undefined,
      },
    );
  });

  describe('reviewer disagreement policy (#64)', () => {
    const CATALOGUE_MD = `# Code-review false positives

---

### Code-reviewer flags \`BETTER_AUTH_DATABASE_URL\` split as "separate auth database" violation

**Pattern:** Code-reviewer reads "do not introduce a separate auth database" in the spec literally and flags BETTER_AUTH_DATABASE_URL as a spec violation when it points at the SAME database.

**Why it's a false positive:** The split is a connection-scope separation (least privilege), not a data separation.
`;

    /** LEA-109 EP#8: security wants the split, code-review calls it a violation. */
    const opposingHighsFanout = (): ReviewerFanoutResult =>
      makeFanout({
        reviewerResults: [
          {
            kind: 'code',
            status: 'done',
            costUsd: 0.01,
            durationMs: 50,
            commentPosted: true,
            findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
            commentBody:
              '# Code Review\n\n- **HIGH** · BETTER_AUTH_DATABASE_URL violates the shared-client spec — revert the split.',
          },
          {
            kind: 'security',
            status: 'done',
            costUsd: 0.01,
            durationMs: 50,
            commentPosted: true,
            findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
            commentBody:
              '# Security Review\n\n- **HIGH** · Shared client runs the whole API on an RLS-bypassing role — split the connection.',
          },
        ],
      });

    beforeEach(() => {
      vi.mocked(buildReviewAdjudicatorParams).mockReturnValue({
        specialistId: 'review-adjudicator',
        prompt: 'adjudicate',
        workdir: '/tmp/ws',
        productSlug: 'test',
        externalId: 'issue_1',
        permissionMode: 'acceptEdits',
        timeoutMs: 1000,
      });
      vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
        status: 'done',
        costUsd: 0.01,
        durationMs: 100,
        commentPosted: true,
        parsed: {
          status: 'AUTO_REMEDIATE',
          unifiedPlan: [
            '- **AUTO** · Keep the least-privilege connection split',
            '- **DEFERRED** · Shared-client spec violation — catalogued adjudication',
          ].join('\n'),
          body: '# Review Adjudication\n\n## Status\nAUTO_REMEDIATE',
          conflictsSection: '',
          conflicts: [],
        },
      });
    });

    it('passes the catalogued side of opposing HIGHs to the adjudicator and remediator', async () => {
      vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(
        parseFalsePositivesCatalog(CATALOGUE_MD),
      );
      vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fanoutReviewers)
        .mockResolvedValueOnce(opposingHighsFanout())
        .mockResolvedValueOnce(
          makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }),
        );

      const result = await runLoop(productWithAdjudicator());

      expect(result.status).toBe('done');

      const catalogued = [
        expect.objectContaining({
          pattern: expect.stringContaining('BETTER_AUTH_DATABASE_URL'),
        }),
      ];
      expect(buildReviewAdjudicatorParams).toHaveBeenCalledWith(
        'issue_1',
        expect.anything(),
        '/tmp/ws',
        PR_URL,
        expect.any(Map),
        expect.objectContaining({ catalogEntries: catalogued }),
      );
      expect(buildRemediationParams).toHaveBeenCalledWith(
        'issue_1',
        expect.anything(),
        '/tmp/ws',
        PR_URL,
        expect.any(Map),
        expect.stringContaining('DEFERRED'),
        expect.anything(),
        undefined,
        { catalogEntries: catalogued },
      );
    });

    it('excludes catalogue entries scoped to other stages', async () => {
      // Built-ins apply to spec-draft/plan-draft only — never to a code PR.
      vi.mocked(fetchFalsePositivesCatalog).mockResolvedValue(builtInFalsePositiveEntries());
      vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fanoutReviewers)
        .mockResolvedValueOnce(opposingHighsFanout())
        .mockResolvedValueOnce(
          makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }),
        );

      const result = await runLoop(productWithAdjudicator());

      expect(result.status).toBe('done');
      expect(buildReviewAdjudicatorParams).toHaveBeenCalledWith(
        'issue_1',
        expect.anything(),
        '/tmp/ws',
        PR_URL,
        expect.any(Map),
        expect.objectContaining({ catalogEntries: [] }),
      );
    });
  });

  it.each([
    {
      kind: 'spec' as const,
      artifactDir: 'specs',
      branchName: 'helm/spec/issue_1',
      content: '# Draft Spec\n\nchecked-out branch content',
    },
    {
      kind: 'plan' as const,
      artifactDir: 'plans',
      branchName: 'helm/plan/issue_1',
      content: '# Draft Plan\n\nchecked-out branch content',
    },
  ])(
    'passes checked-out $kind draft content to adjudication without fetching the default-branch spec',
    async ({ kind, artifactDir, branchName, content }) => {
      const workspacePath = await mkdtemp(join(tmpdir(), `helm-${kind}-draft-`));
      tempDirs.push(workspacePath);
      await mkdir(join(workspacePath, artifactDir), { recursive: true });
      await writeFile(join(workspacePath, artifactDir, 'issue_1.md'), content, 'utf-8');
      vi.mocked(provisionReviewerWorkspace).mockResolvedValue({
        workspacePath,
        branchName,
        artifactsPath: `${workspacePath}-artifacts`,
      });
      vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fanoutReviewers)
        .mockResolvedValueOnce(makeFanout())
        .mockResolvedValueOnce(
          makeFanout({}, { critical: 0, high: 0, medium: 0, low: 0, info: 0 }),
        );
      vi.mocked(fetchSpecForPlan).mockResolvedValue('stale default-branch spec');
      vi.mocked(buildReviewAdjudicatorParams).mockReturnValue({
        specialistId: 'review-adjudicator',
        prompt: 'adjudicate',
        workdir: workspacePath,
        productSlug: 'test',
        externalId: 'issue_1',
        permissionMode: 'acceptEdits',
        timeoutMs: 1000,
      });
      vi.mocked(handleReviewAdjudicatorResult).mockResolvedValue({
        status: 'done',
        costUsd: 0,
        durationMs: 1,
        commentPosted: true,
        parsed: {
          status: 'AUTO_REMEDIATE',
          unifiedPlan: '- **AUTO** · Fix',
          body: '# Review Adjudication\n\n## Status\nAUTO_REMEDIATE',
          conflictsSection: '',
          conflicts: [],
        },
      });

      const result = await runEarlyArtifactReviewLoop({
        kind,
        externalId: 'issue_1',
        product: productWithAdjudicator(),
        prUrl: PR_URL,
        githubToken: 'token',
        runtime: new MockAgentRuntime({ messages: [] }),
        transition: transition as ItemTransitionFn,
        runGit,
      });

      expect(result.status).toBe('done');
      expect(fetchSpecForPlan).not.toHaveBeenCalled();
      expect(buildReviewAdjudicatorParams).toHaveBeenCalledWith(
        'issue_1',
        expect.anything(),
        workspacePath,
        PR_URL,
        expect.any(Map),
        expect.objectContaining({
          draftArtifact: { kind, content },
          spec: undefined,
          codeRepo: { url: 'https://github.com/o/k', default_branch: 'main', role: 'docs' },
          branchName,
        }),
      );
    },
  );

  it.each([
    { kind: 'spec' as const, branchName: 'helm/spec/issue_1', expectedPath: 'specs/issue_1.md' },
    { kind: 'plan' as const, branchName: 'helm/plan/issue_1', expectedPath: 'plans/issue_1.md' },
  ])(
    'fails closed when the checked-out $kind draft artifact is missing',
    async ({ kind, branchName, expectedPath }) => {
      const workspacePath = await mkdtemp(join(tmpdir(), `helm-${kind}-draft-missing-`));
      tempDirs.push(workspacePath);
      vi.mocked(provisionReviewerWorkspace).mockResolvedValue({
        workspacePath,
        branchName,
        artifactsPath: `${workspacePath}-artifacts`,
      });
      vi.mocked(shouldRemediate).mockReturnValue(true);
      vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await runEarlyArtifactReviewLoop({
          kind,
          externalId: 'issue_1',
          product: productWithAdjudicator(),
          prUrl: PR_URL,
          githubToken: 'token',
          runtime: new MockAgentRuntime({ messages: [] }),
          transition: transition as ItemTransitionFn,
          runGit,
        });

        expect(result.status).toBe('error');
        expect(result.error).toBe('Review adjudication failed');
        expect(buildReviewAdjudicatorParams).not.toHaveBeenCalled();
        expect(handleReviewAdjudicatorResult).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(
          '[code-review-loop] Review adjudication failed:',
          `Draft ${kind} artifact not found at ${expectedPath}`,
        );
      } finally {
        consoleSpy.mockRestore();
      }
    },
  );

  it('fails runAdjudicationPass when fetchSpecForPlan throws a non-ENOENT error', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(fetchSpecForPlan).mockRejectedValue(new Error('network down'));

    const result = await runLoop(productWithAdjudicator());

    expect(result.status).toBe('error');
    expect(result.error).toBe('Review adjudication failed');
    expect(handleReviewAdjudicatorResult).not.toHaveBeenCalled();
  });
});

describe('buildFindingsByKind', () => {
  it('merges external blockers into code findings without dropping other reviewer kinds', () => {
    const fanout = makeFanout({
      reviewerResults: [
        {
          kind: 'code',
          status: 'done',
          costUsd: 0.01,
          durationMs: 50,
          commentPosted: true,
          findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          commentBody: 'code issue',
        },
        {
          kind: 'security',
          status: 'done',
          costUsd: 0.01,
          durationMs: 50,
          commentPosted: true,
          findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          commentBody: 'security issue',
        },
        {
          kind: 'test',
          status: 'done',
          costUsd: 0.01,
          durationMs: 50,
          commentPosted: true,
          findings: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
          commentBody: 'missing test',
        },
      ],
    });

    const findingsByKind = buildFindingsByKind(fanout, 'external blocker text');

    expect(findingsByKind.get('security')).toBe('security issue');
    expect(findingsByKind.get('test')).toBe('missing test');
    expect(findingsByKind.get('code')).toContain('code issue');
    expect(findingsByKind.get('code')).toContain('## External review blockers');
    expect(findingsByKind.get('code')).toContain('external blocker text');
  });

  it('uses external blockers alone when code reviewer posted no comment', () => {
    const fanout = makeFanout({
      reviewerResults: [
        {
          kind: 'security',
          status: 'done',
          costUsd: 0.01,
          durationMs: 50,
          commentPosted: true,
          findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          commentBody: 'security only',
        },
      ],
    });

    const findingsByKind = buildFindingsByKind(fanout, 'external blocker');

    expect(findingsByKind.get('security')).toBe('security only');
    expect(findingsByKind.get('code')).toBe('## External review blockers\n\nexternal blocker');
  });
});

describe('formatExternalBlockersForRemediation', () => {
  it('includes severity, summary, path, and fix hints', () => {
    const body = formatExternalBlockersForRemediation([
      {
        id: '1',
        severity: 'high',
        blocking: true,
        summary: 'Missing null check',
        path: 'src/a.ts',
        detail: 'value may be undefined',
        fixHint: 'Add optional chaining',
      },
    ]);

    expect(body).toContain('**HIGH**: Missing null check');
    expect(body).toContain('File: src/a.ts');
    expect(body).toContain('value may be undefined');
    expect(body).toContain('Fix: Add optional chaining');
  });
});
