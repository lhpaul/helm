import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fanoutReviewers, REVIEWER_TIMEOUT_MS } from './reviewer-fanout.js';
import type { IAgentRuntime, SpawnParams, AgentResult, AgentSession } from '../runtime.js';
import type { RunGit, RunGh } from './git-helpers.js';
import type { Product } from '@helm/shared';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeProduct = (): Product => ({
  helm_version: '0',
  product: { slug: 'test-product', name: 'Test Product' },
  issue_tracker: {
    provider: 'github_projects',
    org: 'test-org',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [
    {
      url: 'https://github.com/test-org/test-repo',
      default_branch: 'main',
      role: 'app',
    },
  ],
  knowledge_repo: {
    url: 'https://github.com/test-org/test-knowledge',
    default_branch: 'main',
  },
  workflow: {
    stages_enabled: [
      'discovery',
      'spec-draft',
      'plan-draft',
      'plan-ready',
      'in-development',
      'code-review',
      'released',
    ],
    designer_gate: 'skip',
    qa_gate: 'skip',
  },
  specialists: {
    spec_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    plan_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
    code_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    security_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    test_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    remediation: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
});

const PR_URL = 'https://github.com/test-org/test-repo/pull/42';

/**
 * Creates a mock runGit that simulates provisionReviewerWorkspace's clone step
 * by creating a minimal .git directory in the clone destination.
 */
const makeMockRunGit = (): RunGit =>
  vi.fn().mockImplementation(async (args: string[]) => {
    if (args[0] === 'clone') {
      const dest = args[args.length - 1]!;
      await mkdir(join(dest, '.git'), { recursive: true });
    }
    return { stdout: '' };
  });

/**
 * Creates a mock IAgentRuntime that writes a review.md to params.workdir in spawn.
 */
const makeMockRuntime = (
  agentOutcome: AgentResult['status'] = 'done',
  overrideSpecialistId?: string,
): IAgentRuntime => ({
  spawn: vi.fn().mockImplementation(async (params: SpawnParams): Promise<AgentSession> => {
    // Write review.md if the agent "succeeds"
    if (agentOutcome === 'done') {
      const targetId = overrideSpecialistId ?? params.specialistId;
      await writeFile(join(params.workdir, 'review.md'), `# ${targetId} stub`);
    }

    const result: AgentResult = {
      status: agentOutcome,
      finalOutput: agentOutcome === 'done' ? 'Review complete.' : '',
      totalCostUsd: 0.01,
      durationMs: 100,
    };

    const session: AgentSession = {
      id: `mock-${params.specialistId}`,
      status: agentOutcome,
      onMessage: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(result),
    };
    return session;
  }),
});

/**
 * Creates a mock runGh that returns empty output for comment calls.
 */
const makeMockRunGh = (): RunGh => vi.fn().mockResolvedValue({ stdout: '' });

// ── fanoutReviewers ───────────────────────────────────────────────────────────

describe('fanoutReviewers', () => {
  it('happy path: status done, spawn called 3 times, costUsd = 0.03, durationMs = 100, 3 comments posted', async () => {
    const runGit = makeMockRunGit();
    const runGh = makeMockRunGh();
    const runtime = makeMockRuntime();

    const result = await fanoutReviewers(
      'HLM-42',
      makeProduct(),
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
    );

    expect(result.status).toBe('done');
    expect(result.prUrl).toBe(PR_URL);
    expect(result.costUsd).toBeCloseTo(0.03, 5);
    expect(result.durationMs).toBe(100);
    expect(result.error).toBeUndefined();

    // spawn called 3 times (one per reviewer)
    expect(runtime.spawn).toHaveBeenCalledTimes(3);

    // 3 comments posted (runGh called 3 times for pr comment)
    const commentCalls = (runGh as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const callArgs = args[0] as string[];
        return callArgs[0] === 'pr' && callArgs[1] === 'comment';
      },
    );
    expect(commentCalls).toHaveLength(3);

    // All reviewer results are done
    expect(result.reviewerResults).toHaveLength(3);
    for (const rr of result.reviewerResults) {
      expect(rr.status).toBe('done');
      expect(rr.commentPosted).toBe(true);
    }
  });

  it('one reviewer fails (security-reviewer returns error): overall status error, others complete and post comments', async () => {
    const runGit = makeMockRunGit();
    const runGh = makeMockRunGh();

    // Security reviewer returns error; others succeed
    const runtime: IAgentRuntime = {
      spawn: vi.fn().mockImplementation(async (params: SpawnParams): Promise<AgentSession> => {
        const isSecurityReviewer = params.specialistId === 'security-reviewer';
        const agentStatus: AgentResult['status'] = isSecurityReviewer ? 'error' : 'done';

        if (agentStatus === 'done') {
          await writeFile(join(params.workdir, 'review.md'), `# ${params.specialistId} stub`);
        }

        const agentResult: AgentResult = {
          status: agentStatus,
          finalOutput: agentStatus === 'done' ? 'Review complete.' : '',
          totalCostUsd: 0.01,
          durationMs: 100,
        };

        const session: AgentSession = {
          id: `mock-${params.specialistId}`,
          status: agentStatus,
          onMessage: vi.fn(),
          send: vi.fn().mockResolvedValue(undefined),
          cancel: vi.fn().mockResolvedValue(undefined),
          wait: vi.fn().mockResolvedValue(agentResult),
        };
        return session;
      }),
    };

    const result = await fanoutReviewers(
      'HLM-42',
      makeProduct(),
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
    );

    // Overall status is error because security reviewer failed
    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    expect(result.error).toContain("status 'error'");

    // Three reviewer results returned
    expect(result.reviewerResults).toHaveLength(3);

    // Security reviewer result has error
    const securityResult = result.reviewerResults.find((r) => r.kind === 'security');
    expect(securityResult).toBeDefined();
    expect(securityResult!.status).toBe('error');
    expect(securityResult!.commentPosted).toBe(false);

    // Other two completed and posted comments
    const successfulResults = result.reviewerResults.filter((r) => r.kind !== 'security');
    expect(successfulResults).toHaveLength(2);
    for (const r of successfulResults) {
      expect(r.status).toBe('done');
      expect(r.commentPosted).toBe(true);
    }

    // 2 comments posted (not 3 — security reviewer failed)
    const commentCalls = (runGh as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const callArgs = args[0] as string[];
        return callArgs[0] === 'pr' && callArgs[1] === 'comment';
      },
    );
    expect(commentCalls).toHaveLength(2);
  });

  it('workspace cleanup: all 3 workspace dirs are deleted after fanoutReviewers resolves', async () => {
    const provisionedPaths: string[] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        provisionedPaths.push(dest);
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const runGh = makeMockRunGh();
    const runtime = makeMockRuntime();

    await fanoutReviewers('HLM-42', makeProduct(), PR_URL, 'test-token', runtime, runGit, runGh);

    // Verify all 3 workspaces were tracked and deleted
    expect(provisionedPaths).toHaveLength(3);
    for (const p of provisionedPaths) {
      await expect(access(p)).rejects.toThrow();
    }
  });

  it('returns error immediately when product has no code_repos', async () => {
    const runtime = makeMockRuntime();
    const runGit = makeMockRunGit();
    const runGh = makeMockRunGh();
    const noReposProduct = { ...makeProduct(), code_repos: [] } as unknown as Product;

    const result = await fanoutReviewers(
      'HLM-42',
      noReposProduct,
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('code_repo');
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it('returns error when workspace provisioning fails', async () => {
    const runGit: RunGit = vi.fn().mockRejectedValue(new Error('fatal: repository not found'));
    const runGh = makeMockRunGh();
    const runtime = makeMockRuntime();

    const result = await fanoutReviewers(
      'HLM-42',
      makeProduct(),
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('provision reviewer workspaces');
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it('includes prUrl in the result', async () => {
    const runGit = makeMockRunGit();
    const runGh = makeMockRunGh();
    const runtime = makeMockRuntime();

    const result = await fanoutReviewers(
      'HLM-42',
      makeProduct(),
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
    );

    expect(result.prUrl).toBe(PR_URL);
  });

  it('REVIEWER_TIMEOUT_MS is at least 10 minutes', () => {
    expect(REVIEWER_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1_000);
  });
});
