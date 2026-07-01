import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ItemTransitionFn } from '../specialists/spec-writer.js';
import type { RunGit } from '../specialists/git-helpers.js';
import { MockAgentRuntime } from '../runtimes/mock.js';
import { runCodeReviewLoop } from './code-review-loop.js';

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
vi.mock('../specialists/code-workspace.js', () => ({
  provisionReviewerWorkspace: vi.fn().mockResolvedValue({ workspacePath: '/tmp/ws' }),
  artifactsDirFor: vi.fn((workspacePath: string) => `${workspacePath}-artifacts`),
}));
vi.mock('../external-review/run.js', () => ({
  runExternalReviewIfConfigured: vi.fn().mockResolvedValue({
    status: 'skipped',
    reason: 'not_configured',
  }),
}));

import { fanoutReviewers, shouldRemediate } from '../specialists/reviewer-fanout.js';
import { handleRemediationResult } from '../specialists/remediation.js';
import { provisionReviewerWorkspace } from '../specialists/code-workspace.js';
import { runExternalReviewIfConfigured } from '../external-review/run.js';
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

  it('returns error when remediation fails to push patches', async () => {
    vi.mocked(shouldRemediate).mockReturnValue(true);
    vi.mocked(fanoutReviewers).mockResolvedValue(makeFanout());
    vi.mocked(handleRemediationResult).mockResolvedValueOnce({
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
      newStage: 'remediation',
      error: 'push failed',
    });
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
    transition
      .mockResolvedValueOnce({ currentStage: 'remediation' })
      .mockRejectedValueOnce(new Error('back transition boom'));

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      cyclesCompleted: 1,
      newStage: 'remediation',
    });
    expect(result.error).toContain('Failed to transition back to code-review');
    expect(transition).toHaveBeenCalledTimes(2);
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

  it('escalates when external review reports blockers', async () => {
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'escalate',
      reason: 'blocking_findings',
    });

    const result = await runLoop();

    expect(result).toMatchObject({
      status: 'error',
      escalated: true,
      cyclesCompleted: 1,
    });
    expect(result.error).toContain('External review escalated: blocking_findings');
  });
});
