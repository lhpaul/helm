import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ItemTransitionFn } from '../specialists/spec-writer.js';
import type { RunGit } from '../specialists/git-helpers.js';
import { MockAgentRuntime } from '../runtimes/mock.js';
import {
  runCodeReviewLoop,
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
vi.mock('../specialists/fetch-product-context.js', () => ({
  fetchSpecForPlan: vi.fn().mockResolvedValue(null),
}));
vi.mock('../specialists/code-workspace.js', () => ({
  provisionReviewerWorkspace: vi.fn().mockResolvedValue({ workspacePath: '/tmp/ws' }),
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
vi.mock('../external-review/haystack/skip-evidence.js', () => ({
  fetchHaystackSkipEvidence: vi.fn().mockResolvedValue(null),
}));
vi.mock('../specialists/pr-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../specialists/pr-helpers.js')>();
  return {
    ...actual,
    postPRComment: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('./false-positives.js', () => ({
  fetchFalsePositivesCatalog: vi.fn().mockResolvedValue([]),
}));
vi.mock('./summary.js', () => ({
  upsertReviewLoopSummaryComment: vi.fn().mockResolvedValue(undefined),
}));

import { fanoutReviewers, shouldRemediate } from '../specialists/reviewer-fanout.js';
import { buildRemediationParams, handleRemediationResult } from '../specialists/remediation.js';
import {
  buildReviewAdjudicatorParams,
  handleReviewAdjudicatorResult,
} from '../specialists/review-adjudicator.js';
import { provisionReviewerWorkspace } from '../specialists/code-workspace.js';
import { fetchSpecForPlan } from '../specialists/fetch-product-context.js';
import { runExternalReviewIfConfigured } from '../external-review/run.js';
import { fetchHaystackSkipEvidence } from '../external-review/haystack/skip-evidence.js';
import { postPRComment } from '../specialists/pr-helpers.js';
import { upsertReviewLoopSummaryComment } from './summary.js';
import type { ReviewerFanoutResult, ReviewerResult } from '../specialists/reviewer-fanout.js';

const PR_URL = 'https://github.com/o/r/pull/42';

const baseProduct = {
  helm_version: '0' as const,
  product: { slug: 'test', name: 'Test' },
  issue_tracker: { provider: 'github_projects' as const, org: 'o', project_number: 1 },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' as const }],
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
  workflow: {
    stages_enabled: ['code-review' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
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

  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(fetchHaystackSkipEvidence).mockResolvedValue(null);
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: true,
      pushed: true,
      commitSha: 'sha789',
    });
  });

  afterEach(() => {
    vi.mocked(provisionReviewerWorkspace).mockResolvedValue({ workspacePath: '/tmp/ws' });
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

  it('escalates when max_cycles is reached before another remediation pass', async () => {
    const product: Product = {
      ...baseProduct,
      review: { loop: { max_cycles: 1 } },
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
        loop: { max_cycles: 10, stop_rule: { no_progress_cycles: 2 } },
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
      reason: 'haystack pending_timeout',
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'external_escalate',
      cyclesCompleted: 1,
    });
    expect(result.error).toContain('haystack pending_timeout');
    expect(postPRComment).toHaveBeenCalledTimes(1);
  });

  it('escalates when external review skips with Haystack evidence', async () => {
    const product: Product = {
      ...baseProduct,
      review: { external: { provider: 'haystack', haystack: {} } },
    };
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'skipped',
      reason: 'unavailable',
    });
    vi.mocked(fetchHaystackSkipEvidence).mockResolvedValue({
      kind: 'analysis_ready',
      detail: 'Haystack analysisStatus=ready while triage was unavailable',
    });

    const result = await runLoop(product);

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      escalationReason: 'external_skip_evidence',
    });
    expect(runExternalReviewIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('escalates after repeated external skips without evidence', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: { provider: 'haystack', haystack: { poll_interval_sec: 1 } },
        loop: { stop_rule: { no_progress_cycles: 2 } },
      },
    };
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'skipped',
      reason: 'unavailable',
    });
    vi.mocked(fetchHaystackSkipEvidence).mockResolvedValue(null);

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
      review: { external: { provider: 'haystack', haystack: {} } },
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
        externalProvider: 'haystack',
        advisories: expect.arrayContaining([
          expect.objectContaining({ id: 'adv-1', summary: 'Weak test coverage on summary module' }),
        ]),
      }),
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
      permissionMode: 'default',
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
      permissionMode: 'default',
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
      permissionMode: 'default',
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
      { spec: undefined, resolvedProductDecisions: [] },
    );
  });

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

    const findingsByKind = buildFindingsByKind(fanout, 'haystack blocker');

    expect(findingsByKind.get('security')).toBe('security only');
    expect(findingsByKind.get('code')).toBe('## External review blockers\n\nhaystack blocker');
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
