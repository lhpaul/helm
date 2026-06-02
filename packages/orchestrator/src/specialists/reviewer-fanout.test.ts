import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fanoutReviewers,
  REVIEWER_TIMEOUT_MS,
  buildReviewerParams,
  handleReviewerResult,
  REVIEW_MD_FORMAT,
  parseFindings,
  shouldRemediate,
  type ReviewerResult,
} from './reviewer-fanout.js';
import { artifactFileFor, artifactsDirFor } from './code-workspace.js';
import type { IAgentRuntime, SpawnParams, AgentResult, AgentSession } from '../runtime.js';
import type { RunGit, RunGh } from './git-helpers.js';
import type { CodeRepo, Product } from '@helm/shared';

/**
 * Writes a reviewer's summary to the SIBLING artifacts directory (ADR-025),
 * where handleReviewerResult now reads it from — NOT into the workspace clone.
 */
async function writeReviewArtifact(
  workspacePath: string,
  kind: 'code' | 'security' | 'test',
  content: string,
): Promise<void> {
  const file = artifactFileFor(workspacePath, `${kind}-reviewer`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

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
    'spec-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'plan-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
    'code-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'security-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'test-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'spec-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'plan-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
});

const makeCodeRepo = (): CodeRepo => ({
  url: 'https://github.com/test-org/test-repo',
  default_branch: 'main',
  role: 'app',
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
    // Write the review summary to the sibling artifacts dir if the agent "succeeds".
    if (agentOutcome === 'done') {
      const targetId = overrideSpecialistId ?? params.specialistId;
      const file = artifactFileFor(params.workdir, params.specialistId);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `# ${targetId} stub`);
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

/**
 * Creates a mock fetchFn for spec injection tests.
 * Returns a Response-like object: 200 with spec content, or 404 if specContent is null.
 */
const makeMockFetchFn = (specContent: string | null): typeof fetch =>
  vi.fn().mockResolvedValue({
    status: specContent !== null ? 200 : 404,
    ok: specContent !== null,
    text: () => Promise.resolve(specContent ?? ''),
  }) as unknown as typeof fetch;

// ── buildReviewerParams ───────────────────────────────────────────────────────

describe('buildReviewerParams', () => {
  const product = makeProduct();

  it('code reviewer prompt contains REVIEW_MD_FORMAT and mechanical fix permission', () => {
    const params = buildReviewerParams('code', 'HLM-42', product, '/tmp/ws', PR_URL);
    expect(params.prompt).toContain('**CRITICAL**');
    expect(params.prompt).toContain('apply them directly');
    expect(params.prompt).toContain('do not commit or push');
  });

  it('instructs each reviewer to write its summary to the sibling artifacts path (ADR-025)', () => {
    for (const kind of ['code', 'security', 'test'] as const) {
      const params = buildReviewerParams(kind, 'HLM-42', product, '/tmp/ws', PR_URL);
      // Outside the clone: /tmp/ws-artifacts/<kind>-reviewer.md
      expect(params.prompt).toContain(`/tmp/ws-artifacts/${kind}-reviewer.md`);
      // And explicitly NOT into the working directory.
      expect(params.prompt).toContain('Do NOT create a `review.md` inside the working directory');
    }
  });

  it('security reviewer prompt contains REVIEW_MD_FORMAT and no-modify instruction', () => {
    const params = buildReviewerParams('security', 'HLM-42', product, '/tmp/ws', PR_URL);
    expect(params.prompt).toContain('**CRITICAL**');
    expect(params.prompt).toContain('Do not modify any files in the working directory');
  });

  it('test reviewer prompt contains REVIEW_MD_FORMAT and no-modify instruction', () => {
    const params = buildReviewerParams('test', 'HLM-42', product, '/tmp/ws', PR_URL);
    expect(params.prompt).toContain('**CRITICAL**');
    expect(params.prompt).toContain('Do not modify any files in the working directory');
  });

  it('includes ## Spec section and spec content when spec is provided', () => {
    const specContent = 'AC1: users can log in\nAC2: users can log out';
    const params = buildReviewerParams('code', 'HLM-42', product, '/tmp/ws', PR_URL, specContent);
    expect(params.prompt).toContain('## Spec');
    expect(params.prompt).toContain(specContent);
  });

  it('omits ## Spec section when spec is not provided', () => {
    const params = buildReviewerParams('security', 'HLM-42', product, '/tmp/ws', PR_URL);
    expect(params.prompt).not.toContain('## Spec');
  });

  it('all three prompts include the PR URL and externalId', () => {
    for (const kind of ['code', 'security', 'test'] as const) {
      const params = buildReviewerParams(kind, 'HLM-42', product, '/tmp/ws', PR_URL);
      expect(params.prompt).toContain(PR_URL);
      expect(params.prompt).toContain('HLM-42');
    }
  });

  it('uses bypassPermissions and REVIEWER_TIMEOUT_MS', () => {
    const params = buildReviewerParams('code', 'HLM-42', product, '/tmp/ws', PR_URL);
    expect(params.permissionMode).toBe('bypassPermissions');
    expect(params.timeoutMs).toBe(REVIEWER_TIMEOUT_MS);
  });

  it('REVIEW_MD_FORMAT is exported and contains severity tags', () => {
    expect(REVIEW_MD_FORMAT).toContain('**CRITICAL**');
    expect(REVIEW_MD_FORMAT).toContain('**HIGH**');
    expect(REVIEW_MD_FORMAT).toContain('**MEDIUM**');
    expect(REVIEW_MD_FORMAT).toContain('APPROVED');
    expect(REVIEW_MD_FORMAT).toContain('CHANGES_REQUESTED');
  });

  // ── ## Hints section (per-reviewer extra_hints) ──────────────────────────────

  it('injects each reviewer’s own extra_hints without contaminating the others', () => {
    const p = makeProduct();
    p.specialists['code-reviewer'].extra_hints = ['Check for N+1 queries.'];
    p.specialists['security-reviewer'].extra_hints = ['Verify CSRF tokens are validated.'];
    p.specialists['test-reviewer'].extra_hints = ['Reject tautological assertions.'];

    const code = buildReviewerParams('code', 'HLM-42', p, '/tmp/ws', PR_URL);
    const security = buildReviewerParams('security', 'HLM-42', p, '/tmp/ws', PR_URL);
    const test = buildReviewerParams('test', 'HLM-42', p, '/tmp/ws', PR_URL);

    expect(code.prompt).toContain('## Hints');
    expect(code.prompt).toContain('- Check for N+1 queries.');
    expect(code.prompt).not.toContain('CSRF');
    expect(code.prompt).not.toContain('tautological');

    expect(security.prompt).toContain('- Verify CSRF tokens are validated.');
    expect(security.prompt).not.toContain('N+1');
    expect(security.prompt).not.toContain('tautological');

    expect(test.prompt).toContain('- Reject tautological assertions.');
    expect(test.prompt).not.toContain('N+1');
    expect(test.prompt).not.toContain('CSRF');
  });

  it('omits the ## Hints section for a reviewer with no extra_hints', () => {
    const params = buildReviewerParams('code', 'HLM-42', makeProduct(), '/tmp/ws', PR_URL);
    expect(params.prompt).not.toContain('## Hints');
  });
});

// ── handleReviewerResult ──────────────────────────────────────────────────────

describe('handleReviewerResult', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `test-handle-ws-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    await rm(artifactsDirFor(workspacePath), { recursive: true, force: true }).catch(() => {});
  });

  const makeAgentResult = (status: AgentResult['status'] = 'done'): AgentResult => ({
    status,
    finalOutput: status === 'done' ? 'Review complete.' : '',
    totalCostUsd: 0.01,
    durationMs: 100,
  });

  it('code + review.md + no workspace changes: commentPosted:true, status:done, only status git call', async () => {
    await writeReviewArtifact(
      workspacePath,
      'code',
      '# Code Review: HLM-42\n\n## Status\nAPPROVED',
    );

    const gitCalls: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      gitCalls.push([...args]);
      if (args[0] === 'status') return { stdout: '' }; // clean — no changes
      return { stdout: '' };
    });
    const runGh = makeMockRunGh();

    const result = await handleReviewerResult(
      'code',
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('done');
    expect(result.commentPosted).toBe(true);
    // Only status was called (no add/commit/push since workspace was clean)
    const nonStatusCalls = gitCalls.filter((a) => a[0] !== 'status');
    expect(nonStatusCalls).toHaveLength(0);
  });

  it('code + review.md + has workspace changes: comment includes commit SHA', async () => {
    await writeReviewArtifact(
      workspacePath,
      'code',
      '# Code Review: HLM-42\n\n## Status\nAPPROVED',
    );

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' }; // dirty
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      return { stdout: '' };
    });
    const capturedCommentBodies: string[] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      // Capture the --body argument from gh pr comment calls
      const bodyIdx = args.indexOf('--body');
      if (bodyIdx !== -1 && args[bodyIdx + 1]) {
        capturedCommentBodies.push(args[bodyIdx + 1]!);
      }
      return { stdout: '' };
    });

    const result = await handleReviewerResult(
      'code',
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('done');
    expect(result.commentPosted).toBe(true);
    // The posted comment body must contain the commit SHA
    expect(capturedCommentBodies.some((b) => b.includes('abc123'))).toBe(true);
  });

  it('security reviewer: runGit is NOT called (no push path for security)', async () => {
    await writeReviewArtifact(
      workspacePath,
      'security',
      '# Security Review: HLM-42\n\n## Status\nAPPROVED',
    );

    const runGit: RunGit = vi.fn().mockResolvedValue({ stdout: '' });
    const runGh = makeMockRunGh();

    const result = await handleReviewerResult(
      'security',
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('done');
    expect(result.commentPosted).toBe(true);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('test reviewer: runGit is NOT called (no push path for test reviewer)', async () => {
    await writeReviewArtifact(
      workspacePath,
      'test',
      '# Test Review: HLM-42\n\n## Status\nAPPROVED',
    );

    const runGit: RunGit = vi.fn().mockResolvedValue({ stdout: '' });
    const runGh = makeMockRunGh();

    const result = await handleReviewerResult(
      'test',
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('done');
    expect(result.commentPosted).toBe(true);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('code + comment fails: status:error, commentPosted:false', async () => {
    await writeReviewArtifact(
      workspacePath,
      'code',
      '# Code Review: HLM-42\n\n## Status\nAPPROVED',
    );

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: '' }; // clean
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockRejectedValue(new Error('gh: rate limit exceeded'));

    const result = await handleReviewerResult(
      'code',
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('error');
    expect(result.commentPosted).toBe(false);
    expect(result.error).toContain('Failed to post PR comment');
  });

  it('code + push fails after comment: status:error, commentPosted:true, error contains push failed', async () => {
    await writeReviewArtifact(
      workspacePath,
      'code',
      '# Code Review: HLM-42\n\n## Status\nAPPROVED',
    );

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' }; // dirty
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      if (args[0] === 'push') throw new Error('fatal: remote rejected');
      return { stdout: '' };
    });
    const runGh = makeMockRunGh();

    const result = await handleReviewerResult(
      'code',
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('error');
    expect(result.commentPosted).toBe(true);
    expect(result.error).toContain('push failed');
  });

  it('agent status error: returns error without reading review.md or posting comment', async () => {
    const runGit: RunGit = vi.fn();
    const runGh: RunGh = vi.fn();

    const result = await handleReviewerResult(
      'code',
      'HLM-42',
      makeAgentResult('error'),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      runGit,
    );

    expect(result.status).toBe('error');
    expect(result.commentPosted).toBe(false);
    expect(result.error).toContain("status 'error'");
    expect(runGit).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });
});

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
          {
            const file = artifactFileFor(params.workdir, params.specialistId);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, `# ${params.specialistId} stub`);
          }
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

  it('spec fetched and injected: all 3 reviewer prompts contain the spec content', async () => {
    const specContent = 'AC1: users can log in\nAC2: session expires after 30 minutes';
    const fetchFn = makeMockFetchFn(specContent);

    const spawnedParams: SpawnParams[] = [];
    const runtime: IAgentRuntime = {
      spawn: vi.fn().mockImplementation(async (params: SpawnParams): Promise<AgentSession> => {
        spawnedParams.push(params);
        await writeFile(join(params.workdir, 'review.md'), `# ${params.specialistId} stub`);
        const result: AgentResult = {
          status: 'done',
          finalOutput: 'Review complete.',
          totalCostUsd: 0.01,
          durationMs: 100,
        };
        const session: AgentSession = {
          id: `mock-${params.specialistId}`,
          status: 'done',
          onMessage: vi.fn(),
          send: vi.fn().mockResolvedValue(undefined),
          cancel: vi.fn().mockResolvedValue(undefined),
          wait: vi.fn().mockResolvedValue(result),
        };
        return session;
      }),
    };

    const runGit = makeMockRunGit();
    const runGh = makeMockRunGh();

    await fanoutReviewers(
      'HLM-42',
      makeProduct(),
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
      fetchFn,
    );

    expect(spawnedParams).toHaveLength(3);
    for (const params of spawnedParams) {
      expect(params.prompt).toContain('## Spec');
      expect(params.prompt).toContain(specContent);
    }
  });

  it('spec fetch fails: dispatch continues, all 3 prompts posted without spec section', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const spawnedParams: SpawnParams[] = [];
    const runtime: IAgentRuntime = {
      spawn: vi.fn().mockImplementation(async (params: SpawnParams): Promise<AgentSession> => {
        spawnedParams.push(params);
        await writeFile(join(params.workdir, 'review.md'), `# ${params.specialistId} stub`);
        const result: AgentResult = {
          status: 'done',
          finalOutput: 'Review complete.',
          totalCostUsd: 0.01,
          durationMs: 100,
        };
        const session: AgentSession = {
          id: `mock-${params.specialistId}`,
          status: 'done',
          onMessage: vi.fn(),
          send: vi.fn().mockResolvedValue(undefined),
          cancel: vi.fn().mockResolvedValue(undefined),
          wait: vi.fn().mockResolvedValue(result),
        };
        return session;
      }),
    };

    const runGit = makeMockRunGit();
    const runGh = makeMockRunGh();

    const result = await fanoutReviewers(
      'HLM-42',
      makeProduct(),
      PR_URL,
      'test-token',
      runtime,
      runGit,
      runGh,
      fetchFn,
    );

    // Dispatch should succeed despite spec fetch failure
    expect(result.status).toBe('done');
    expect(spawnedParams).toHaveLength(3);
    // Prompts should NOT contain ## Spec since fetch failed
    for (const params of spawnedParams) {
      expect(params.prompt).not.toContain('## Spec');
    }
  });
});

// ── parseFindings ─────────────────────────────────────────────────────────────

describe('parseFindings', () => {
  it('counts each severity level', () => {
    const body = [
      '# Security Review: HLM-42',
      '## Findings',
      '- **CRITICAL** · SQL injection in query builder',
      '- **HIGH** · Missing auth check on /admin',
      '- **HIGH** · Secrets logged in plaintext',
      '- **MEDIUM** · Weak password policy',
      '- **LOW** · Verbose error message',
      '- **INFO** · Consider rate limiting',
    ].join('\n');

    const findings = parseFindings(body);
    expect(findings).toEqual({ critical: 1, high: 2, medium: 1, low: 1, info: 1 });
  });

  it('returns all zeros when there are no findings', () => {
    const body = '# Code Review: HLM-42\n\n## Status\nAPPROVED';
    expect(parseFindings(body)).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  });

  it('is robust to additional markdown and varied spacing around the separator', () => {
    const body = [
      '## Findings',
      '',
      '### Issue 1',
      '> **CRITICAL** ·   Path traversal',
      '',
      'Some prose with **bold** that is not a finding tag.',
      '',
      '1. **HIGH** · Broken access control',
      '   nested description line',
    ].join('\n');

    const findings = parseFindings(body);
    expect(findings.critical).toBe(1);
    expect(findings.high).toBe(1);
    expect(findings.medium).toBe(0);
  });

  it('does not count bare bold severity words without the separator', () => {
    const body = 'We rate this **CRITICAL** overall but found no specific issues.';
    expect(parseFindings(body).critical).toBe(0);
  });
});

// ── shouldRemediate ───────────────────────────────────────────────────────────

describe('shouldRemediate', () => {
  const make = (
    kind: ReviewerResult['kind'],
    findings: ReviewerResult['findings'],
  ): ReviewerResult => ({
    kind,
    status: 'done',
    costUsd: 0,
    durationMs: 0,
    commentPosted: true,
    findings,
  });

  const zero = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  it('true when security has a CRITICAL finding', () => {
    expect(shouldRemediate([make('security', { ...zero, critical: 1 })])).toBe(true);
  });

  it('true when test has a HIGH finding', () => {
    expect(shouldRemediate([make('test', { ...zero, high: 1 })])).toBe(true);
  });

  it('true when only code has a CRITICAL finding (code gates via remediator safety net, ADR-025)', () => {
    expect(shouldRemediate([make('code', { ...zero, critical: 3 })])).toBe(true);
  });

  it('true when only code has a HIGH finding (ADR-025)', () => {
    expect(shouldRemediate([make('code', { ...zero, high: 1 })])).toBe(true);
  });

  it('false when code only has MEDIUM/LOW/INFO findings', () => {
    expect(shouldRemediate([make('code', { ...zero, medium: 2, low: 1, info: 3 })])).toBe(false);
  });

  it('false when sec/test only have MEDIUM/LOW/INFO', () => {
    expect(
      shouldRemediate([
        make('security', { ...zero, medium: 2, low: 1 }),
        make('test', { ...zero, info: 5 }),
      ]),
    ).toBe(false);
  });

  it('false for an empty array', () => {
    expect(shouldRemediate([])).toBe(false);
  });

  it('false when a sec reviewer errored and has no findings field', () => {
    const errored: ReviewerResult = {
      kind: 'security',
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      commentPosted: false,
    };
    expect(shouldRemediate([errored])).toBe(false);
  });
});

// ── handleReviewerResult: findings + commentBody ───────────────────────────────

describe('handleReviewerResult findings population', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `test-findings-ws-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    await rm(artifactsDirFor(workspacePath), { recursive: true, force: true }).catch(() => {});
  });

  it('populates findings and commentBody when a comment is posted', async () => {
    await writeReviewArtifact(
      workspacePath,
      'security',
      '# Security Review: HLM-42\n\n## Findings\n- **CRITICAL** · injection\n- **HIGH** · authz',
    );
    const runGh = makeMockRunGh();

    const result = await handleReviewerResult(
      'security',
      'HLM-42',
      { status: 'done', finalOutput: '', totalCostUsd: 0.01, durationMs: 100 },
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGh,
      vi.fn().mockResolvedValue({ stdout: '' }),
    );

    expect(result.findings).toEqual({ critical: 1, high: 1, medium: 0, low: 0, info: 0 });
    expect(result.commentBody).toContain('**CRITICAL** · injection');
  });

  it('omits findings and commentBody when the agent errored (no comment)', async () => {
    const result = await handleReviewerResult(
      'security',
      'HLM-42',
      { status: 'error', finalOutput: '', totalCostUsd: 0.01, durationMs: 100 },
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      vi.fn(),
      vi.fn(),
    );

    expect(result.findings).toBeUndefined();
    expect(result.commentBody).toBeUndefined();
  });
});
