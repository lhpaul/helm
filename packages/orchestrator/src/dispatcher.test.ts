import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchStageHandler, resolveSpecialistId } from './dispatcher.js';

vi.mock('./specialists/pr-helpers.js', () => ({
  findCodePRUrl: vi.fn().mockResolvedValue('https://github.com/test-org/test-repo/pull/42'),
  findArtifactPRUrl: vi.fn().mockResolvedValue('https://github.com/test-org/test-knowledge/pull/7'),
  postPRComment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./specialists/early-remediator.js', () => ({
  runEarlyRemediation: vi.fn().mockResolvedValue({
    status: 'done',
    costUsd: 0.04,
    durationMs: 321,
    pushed: true,
    commitSha: 'remsha123',
    prUrl: 'https://github.com/test-org/test-knowledge/pull/7',
  }),
}));
vi.mock('./specialists/reviewer-fanout.js', () => ({
  fanoutReviewers: vi.fn().mockResolvedValue({
    reviewerResults: [],
    prUrl: 'https://github.com/test-org/test-repo/pull/42',
    status: 'done',
    costUsd: 0.03,
    durationMs: 100,
  }),
  shouldRemediate: vi.fn().mockReturnValue(false),
}));
vi.mock('./specialists/remediation.js', () => ({
  buildRemediationParams: vi.fn().mockReturnValue({
    specialistId: 'code-remediator',
    prompt: 'remediate',
    workdir: '/tmp',
    productSlug: 'test-product',
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
vi.mock('./external-review/run.js', () => ({
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
vi.mock('./external-review/haystack/skip-evidence.js', () => ({
  fetchHaystackSkipEvidence: vi.fn().mockResolvedValue(null),
}));

// Lazy imports for the mocked modules (imported after vi.mock hoisting).
// We use type-safe lazy accessors so we can manipulate mock return values per test.
import { findCodePRUrl, findArtifactPRUrl } from './specialists/pr-helpers.js';
import { runEarlyRemediation } from './specialists/early-remediator.js';
import { fanoutReviewers, shouldRemediate } from './specialists/reviewer-fanout.js';
import { buildRemediationParams, handleRemediationResult } from './specialists/remediation.js';
import { runExternalReviewIfConfigured } from './external-review/run.js';
import { MockAgentRuntime } from './runtimes/mock.js';
import type { Product } from '@helm/shared';
import type { ItemTransitionFn } from './specialists/spec-writer.js';
import type { FetchFn } from './specialists/fetch-product-context.js';
import type { RunGit, RunGh } from './specialists/spec-publisher.js';

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
  code_repos: [{ url: 'https://github.com/test-org/test', default_branch: 'main', role: 'app' }],
  knowledge_repo: {
    url: 'https://github.com/test-org/test-knowledge',
    default_branch: 'main',
  },
  workflow: {
    stages_enabled: ['discovery', 'spec-draft', 'released'],
    designer_gate: 'skip',
    qa_gate: 'skip',
    readiness_gate: 'skip',
    final_stage: 'released',
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

/** MockAgentRuntime that writes specs/{externalId}.md as a side effect. */
const makeSpecWriterRuntime = (externalId: string) =>
  new MockAgentRuntime({
    messages: [{ role: 'agent', content: 'Writing spec…', timestamp: new Date().toISOString() }],
    sideEffects: async (dir) => {
      await mkdir(join(dir, 'specs'), { recursive: true });
      await writeFile(join(dir, 'specs', `${externalId}.md`), `# ${externalId}\n`);
    },
  });

/** MockAgentRuntime that writes plans/{externalId}.md as a side effect. */
const makePlanWriterRuntime = (externalId: string) =>
  new MockAgentRuntime({
    messages: [{ role: 'agent', content: 'Writing plan…', timestamp: new Date().toISOString() }],
    sideEffects: async (dir) => {
      await mkdir(join(dir, 'plans'), { recursive: true });
      await writeFile(join(dir, 'plans', `${externalId}.md`), `# ${externalId} — Plan\n`);
    },
  });

/**
 * Builds a mock fetchFn for plan-writer dispatcher tests.
 * Returns spec content for knowledge-repo spec URL; 404 for everything else.
 */
const makePlanFetchFn = (specContent = '# Spec content'): FetchFn =>
  vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes('/specs/')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(specContent),
      } as Response);
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as Response);
  });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dispatchStageHandler', () => {
  let workdir: string;
  let transition: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workdir = join(tmpdir(), `dispatcher-${randomUUID()}`);
    await mkdir(workdir, { recursive: true });
    transition = vi.fn().mockResolvedValue({ currentStage: 'spec-draft' });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('returns error when no specialist is mapped for the stage', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir },
    );

    expect(result.status).toBe('error');
    expect(result.specialistId).toBe('none');
    expect(result.error).toContain("No specialist mapped for stage 'spec-draft'");
    expect(transition).not.toHaveBeenCalled();
  });

  it('routes discovery stage to spec-writer and transitions to spec-draft', async () => {
    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir },
    );

    expect(result.specialistId).toBe('spec-writer');
    expect(result.status).toBe('done');
    expect(result.newStage).toBe('spec-draft');
    expect(result.costUsd).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(transition).toHaveBeenCalledOnce();
  });

  it('creates workdir automatically when it does not exist', async () => {
    const deepWorkdir = join(tmpdir(), `new-${randomUUID()}`, 'deep', 'path');

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir: deepWorkdir },
    );

    expect(result.status).toBe('done');
    await rm(deepWorkdir, { recursive: true, force: true });
  });

  it('respects specialistId override in options', async () => {
    // Override forces spec-writer even though stage is spec-draft (no mapping)
    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, specialistId: 'spec-writer' },
    );

    expect(result.specialistId).toBe('spec-writer');
    expect(result.status).toBe('done');
  });

  it('propagates agent error status in result without transitioning', async () => {
    const errorRuntime = new MockAgentRuntime({
      messages: [{ role: 'agent', content: 'agent failed', timestamp: new Date().toISOString() }],
      outcome: 'error',
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      errorRuntime,
      transition as ItemTransitionFn,
      { workdir },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns error when spec file is not created by the agent', async () => {
    // Runtime runs successfully but does NOT write specs/issue_1.md
    const noFileRuntime = new MockAgentRuntime({
      messages: [
        { role: 'agent', content: 'done but forgot the file', timestamp: new Date().toISOString() },
      ],
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      noFileRuntime,
      transition as ItemTransitionFn,
      { workdir },
    );

    // Agent reported done but post-completion check fails — dispatch status is 'error'
    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns not-implemented error for unknown specialist override', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, specialistId: 'future-specialist' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not implemented');
    expect(result.specialistId).toBe('future-specialist');
  });

  it('calls fetchFn when githubToken is provided', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as Response);

    // Provide runner mocks so the publish step (also triggered by githubToken)
    // doesn't attempt a real git clone during this context-fetch test.
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        await mkdir(join(args[2]!, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create')
        return { stdout: 'https://github.com/test-org/knowledge/pull/1\n' };
      return { stdout: '' };
    });

    await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn: mockFetch, runGit, runGh },
    );

    expect(mockFetch).toHaveBeenCalled();
  });

  it('does not call fetchFn when githubToken is absent', async () => {
    const mockFetch: FetchFn = vi.fn();

    await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, fetchFn: mockFetch },
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('continues dispatch when context fetch throws (fallback to no context)', async () => {
    const mockFetch: FetchFn = vi.fn().mockRejectedValue(new Error('network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Provide runner mocks so the publish step (also triggered by githubToken)
    // succeeds and doesn't mask the context-fetch fallback being tested.
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        await mkdir(join(args[2]!, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create')
        return { stdout: 'https://github.com/test-org/knowledge/pull/1\n' };
      return { stdout: '' };
    });

    try {
      const result = await dispatchStageHandler(
        { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
        makeProduct(),
        makeSpecWriterRuntime('issue_1'),
        transition as ItemTransitionFn,
        { workdir, githubToken: 'test-token', fetchFn: mockFetch, runGit, runGh },
      );

      expect(result.status).toBe('done');
      expect(result.newStage).toBe('spec-draft');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[dispatcher]'),
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('omits prUrl when githubToken is absent (publish step skipped)', async () => {
    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, dataRoot: '/some/data' }, // dataRoot present but no token
    );

    expect(result.status).toBe('done');
    expect(result.prUrl).toBeUndefined();
  });

  it('returns error when productSlug starts with a dot (dot-segment traversal)', async () => {
    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: '.hidden-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir },
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Invalid productSlug or externalId/);
  });

  it('returns error when externalId is ".." (parent-directory traversal)', async () => {
    const result = await dispatchStageHandler(
      { externalId: '..', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir },
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Invalid productSlug or externalId/);
  });

  it('path-validation fires before default workdir is computed (dot productSlug, no custom workdir)', async () => {
    // Guard must reject before dispatcher tries to mkdir the default
    // data/worktrees/{productSlug}/{externalId} path, which would embed the
    // untrusted value directly into a filesystem path.
    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: '.hidden', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      // intentionally no `workdir` option
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Invalid productSlug or externalId/);
    expect(transition).not.toHaveBeenCalled();
  });

  it('path-validation fires before default workdir is computed (dotdot externalId, no custom workdir)', async () => {
    const result = await dispatchStageHandler(
      { externalId: '..', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      // intentionally no `workdir` option
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Invalid productSlug or externalId/);
    expect(transition).not.toHaveBeenCalled();
  });

  it('propagates prUrl from publish step when token and dataRoot are provided', async () => {
    const expectedPrUrl = 'https://github.com/test-org/test-knowledge/pull/5';

    // Stub runners: clone creates a .git dir; gh create returns a PR URL.
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const cloneDest = args[2]!;
        await mkdir(join(cloneDest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${expectedPrUrl}\n` };
      return { stdout: '' };
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit, runGh },
    );

    expect(result.status).toBe('done');
    expect(result.prUrl).toBe(expectedPrUrl);
  });

  // ── plan-writer routing ────────────────────────────────────────────────────

  it('routes spec-ready to plan-writer and transitions to plan-draft', async () => {
    transition.mockResolvedValue({ currentStage: 'plan-draft' });

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        await mkdir(join(args[2]!, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create')
        return { stdout: 'https://github.com/test-org/test-knowledge/pull/9\n' };
      return { stdout: '' };
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      makePlanWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      {
        workdir,
        githubToken: 'test-token',
        fetchFn: makePlanFetchFn(),
        runGit,
        runGh,
      },
    );

    expect(result.specialistId).toBe('plan-writer');
    expect(result.status).toBe('done');
    expect(result.newStage).toBe('plan-draft');
    expect(transition).toHaveBeenCalledOnce();
  });

  it('plan-writer returns error without spawning when githubToken is absent', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir }, // no githubToken
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('GITHUB_TOKEN');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('plan-writer returns error without spawning when spec is not found', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    // fetchFn always returns 404 — spec is absent in knowledge repo
    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as Response);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain("Spec not found for item 'issue_1'");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  // ── implementer routing ───────────────────────────────────────────────────

  it('implementer returns error without spawning when githubToken is absent', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir }, // no githubToken
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('GITHUB_TOKEN');
    expect(result.specialistId).toBe('implementer');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('implementer returns error without spawning when plan is not found', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    // fetchFn always returns 404 — plan is absent in knowledge repo
    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as Response);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain("Plan not found for item 'issue_1'");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('implementer routes plan-ready, transitions in-development then code-review, returns prUrl', async () => {
    // transition mock: first call → in-development, second call → code-review
    transition
      .mockResolvedValueOnce({ currentStage: 'in-development' })
      .mockResolvedValueOnce({ currentStage: 'code-review' });

    // fetchFn: returns plan content for knowledge repo, 404 for everything else
    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('/plans/')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# Plan content'),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });

    const expectedPrUrl = 'https://github.com/test-org/test/pull/7';

    // runGit: clone creates .git dir; status returns dirty; other calls succeed
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      if (args[0] === 'status') return { stdout: 'M  src/impl.ts\n' };
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${expectedPrUrl}\n` };
      return { stdout: '' };
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      makeProduct(),
      // The implementer agent succeeds without side-effects (the workspace was
      // provisioned via provisionCodeWorkspace — the mock write doesn't matter here)
      new MockAgentRuntime({ messages: [] }),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
    );

    expect(result.specialistId).toBe('implementer');
    expect(result.status).toBe('done');
    // plan-ready → in-development (after clone, before agent), in-development → code-review (after PR)
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toStage: 'in-development' }),
    );
    expect(transition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toStage: 'code-review' }),
    );
    expect(result.newStage).toBe('code-review');
    expect(result.prUrl).toBe(expectedPrUrl);
  });

  // ── Product-context materialization (ADR-030) ──────────────────────────────
  // The spec-writer / plan-writer scratch worktree gets the full README + winning
  // agent instruction file written to disk before the agent spawns; the
  // implementer does not (it has CLAUDE.md via its shallow clone). The unique,
  // observable signature of a materialize call is a README.md / agent file landing
  // in `workdir`, so these tests assert on the worktree contents.

  /** A clone-faking runGit + pr-list/create runGh, for paths that also publish. */
  const makePublishRunners = (prUrl: string): { runGit: RunGit; runGh: RunGh } => ({
    runGit: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone')
        await mkdir(join(args[args.length - 1]!, '.git'), { recursive: true });
      if (args[0] === 'status') return { stdout: 'M  file\n' };
      return { stdout: '' };
    }),
    runGh: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${prUrl}\n` };
      return { stdout: '' };
    }),
  });

  it('spec-writer materializes the full README + agent instructions into the worktree (ADR-030)', async () => {
    const longReadme = '# Full README\n' + 'x'.repeat(3000); // exceeds the 2000-char prompt cap
    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('README.md'))
        return Promise.resolve({ ok: true, text: () => Promise.resolve(longReadme) } as Response);
      if (url.includes('CLAUDE.md'))
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# CLAUDE full'),
        } as Response);
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });
    const { runGit, runGh } = makePublishRunners(
      'https://github.com/test-org/test-knowledge/pull/1',
    );

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
    );

    expect(result.status).toBe('done');
    // Full files on disk — verbatim, no truncation suffix.
    const readmeOnDisk = await readFile(join(workdir, 'README.md'), 'utf8');
    expect(readmeOnDisk).toBe(longReadme);
    expect(readmeOnDisk.length).toBeGreaterThan(2000);
    expect(await readFile(join(workdir, 'CLAUDE.md'), 'utf8')).toBe('# CLAUDE full');
  });

  it('spec-writer continues the dispatch when materialization fails (best-effort .catch)', async () => {
    // A non-404 HTTP error makes materializeProductContext reject. The dispatcher
    // must swallow it (log + continue), not abort the spec-writer dispatch.
    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('README.md'))
        return Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve('Forbidden'),
        } as Response);
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });
    const { runGit, runGh } = makePublishRunners(
      'https://github.com/test-org/test-knowledge/pull/3',
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await dispatchStageHandler(
        { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
        makeProduct(),
        makeSpecWriterRuntime('issue_1'),
        transition as ItemTransitionFn,
        { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
      );

      // Dispatch still completes despite the materialization failure.
      expect(result.status).toBe('done');
      expect(result.newStage).toBe('spec-draft');
      // The materialize-specific best-effort log fired (distinct from the Part A
      // context-fetch log, so we know it was the materialize catch).
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to materialize product context into worktree'),
        expect.any(Error),
      );
      // Nothing materialized — the worktree lacks the README/agent files.
      const entries = await readdir(workdir);
      expect(entries).not.toContain('README.md');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('spec-writer skips materialization when no githubToken is provided', async () => {
    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir }, // no token → Part A and materialization both skipped
    );

    expect(result.status).toBe('done');
    const entries = await readdir(workdir);
    expect(entries).not.toContain('README.md');
    expect(entries).not.toContain('CLAUDE.md');
  });

  it('plan-writer materializes the README + winning agent instruction file into the worktree', async () => {
    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/specs/'))
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# Spec content'),
        } as Response);
      if (url.includes('README.md'))
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# README for plan'),
        } as Response);
      if (url.includes('AGENTS.md'))
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# AGENTS for plan'),
        } as Response);
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });
    const { runGit, runGh } = makePublishRunners(
      'https://github.com/test-org/test-knowledge/pull/2',
    );

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      makePlanWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
    );

    expect(result.specialistId).toBe('plan-writer');
    expect(result.status).toBe('done');
    expect(await readFile(join(workdir, 'README.md'), 'utf8')).toBe('# README for plan');
    // AGENTS.md wins the preference order and is written under its real variant name.
    expect(await readFile(join(workdir, 'AGENTS.md'), 'utf8')).toBe('# AGENTS for plan');
    expect(await readdir(workdir)).not.toContain('CLAUDE.md');
  });

  it('implementer does NOT materialize product context into the scratch worktree', async () => {
    transition
      .mockResolvedValueOnce({ currentStage: 'in-development' })
      .mockResolvedValueOnce({ currentStage: 'code-review' });

    // README/CLAUDE are served (the implementer's fetchProductContext still pulls
    // them for prompt injection) — but no materialize call means they must not
    // appear in `workdir`. The implementer reads CLAUDE.md from its shallow clone.
    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/plans/'))
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# Plan content'),
        } as Response);
      if (url.includes('README.md'))
        return Promise.resolve({ ok: true, text: () => Promise.resolve('# README') } as Response);
      if (url.includes('CLAUDE.md'))
        return Promise.resolve({ ok: true, text: () => Promise.resolve('# CLAUDE') } as Response);
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });
    const { runGit, runGh } = makePublishRunners('https://github.com/test-org/test/pull/9');

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      makeProduct(),
      new MockAgentRuntime({ messages: [] }),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
    );

    expect(result.specialistId).toBe('implementer');
    // The scratch workdir is left clean — materialization is spec/plan-writer only.
    const entries = await readdir(workdir);
    expect(entries).not.toContain('README.md');
    expect(entries).not.toContain('CLAUDE.md');
  });

  it('implementer returns error without spawning when product has no code_repos', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    // Cast through unknown to bypass the strict Zod-generated type — this
    // simulates a product that passed validation but has an empty code_repos
    // array (possible if the Zod schema is relaxed in a future version).
    const productNoRepos = { ...makeProduct(), code_repos: [] } as unknown as Product;

    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('# Plan content'),
    } as Response);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      productNoRepos,
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('code_repo');
    expect(result.specialistId).toBe('implementer');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('implementer returns error when provisionCodeWorkspace fails (clone error)', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('/plans/')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('# Plan') } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });

    // runGit throws on clone — simulates network/auth failure
    const runGit: RunGit = vi.fn().mockRejectedValue(new Error('fatal: repository not found'));

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn, runGit },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('provision code workspace');
    expect(spawnSpy).not.toHaveBeenCalled();
    // Provision fails BEFORE the stage transition — item stays in plan-ready (re-dispatchable).
    expect(transition).not.toHaveBeenCalled();
  });

  // ── Honest status: agent done but post-agent step fails ───────────────────
  // Verifies that DispatchResult.status is 'error' whenever the post-agent
  // step (publish, PR, transition) fails, even when agentResult.status is 'done'.
  // This ensures the job status surfaced to operators reflects the true outcome.

  it('spec-writer: status is error when transition fails after spec is written', async () => {
    // Agent writes the spec file; transition then throws.
    transition.mockRejectedValueOnce(new Error('store unavailable'));

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir }, // no token → publish skipped; transition is still called
    );

    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    // costUsd / durationMs come from the agent result
    expect(result.costUsd).toBeDefined();
  });

  it('spec-writer: status is error when publish (PR creation) fails after spec is written', async () => {
    // Agent writes the spec file; git clone for publish throws.
    const runGit: RunGit = vi.fn().mockRejectedValue(new Error('fatal: clone failed'));

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      makeSpecWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    expect(transition).not.toHaveBeenCalled(); // transition never reached
  });

  it('plan-writer: status is error when plan file is not written by the agent', async () => {
    // Agent runs successfully but does NOT write plans/issue_1.md
    const noFileRuntime = new MockAgentRuntime({ messages: [] }); // no sideEffects

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      noFileRuntime,
      transition as ItemTransitionFn,
      {
        workdir,
        githubToken: 'test-token',
        fetchFn: makePlanFetchFn(), // spec fetch succeeds
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    expect(transition).not.toHaveBeenCalled();
  });

  it('plan-writer: status is error when publish (PR creation) fails after plan is written', async () => {
    // Agent writes the plan file; git clone for publish throws.
    const runGit: RunGit = vi.fn().mockRejectedValue(new Error('fatal: clone failed'));

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      makePlanWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      {
        workdir,
        githubToken: 'test-token',
        fetchFn: makePlanFetchFn(), // spec fetch succeeds
        runGit,
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    expect(transition).not.toHaveBeenCalled(); // transition never reached
  });

  it('implementer: status is error when agent produces no file changes (the e2e scenario)', async () => {
    // The exact scenario from the first end-to-end run: agent finishes (done)
    // but makes no file changes → openCodePR returns prUrl: '' → handler error.
    // Before this fix the job reported status: 'done' even though no PR was opened
    // and the item was stuck in in-development.
    transition
      .mockResolvedValueOnce({ currentStage: 'in-development' })
      .mockResolvedValueOnce({ currentStage: 'code-review' });

    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('/plans/')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('# Plan') } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });

    // runGit: clone creates .git dir; status returns CLEAN (no changes made by agent)
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      if (args[0] === 'status') return { stdout: '' }; // clean — agent made no changes
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await dispatchStageHandler(
        { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
        makeProduct(),
        new MockAgentRuntime({ messages: [] }),
        transition as ItemTransitionFn,
        { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
      );

      expect(result.specialistId).toBe('implementer');
      expect(result.status).toBe('error'); // honest: no PR, no transition to code-review
      expect(result.error).toContain('no file changes');
      // in-development transition fired (agent ran), but code-review transition did NOT
      expect(transition).toHaveBeenCalledOnce();
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ toStage: 'in-development' }),
      );
      // gh must not have been called — clean workspace means no PR attempt
      expect(runGh).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('implementer: status is error with prUrl preserved when code-review transition fails after PR opened', async () => {
    // Agent finishes (done), PR is opened successfully, but the code-review
    // transition throws. prUrl must be preserved so operators can find the PR.
    const openedPrUrl = 'https://github.com/test-org/test/pull/11';

    transition
      .mockResolvedValueOnce({ currentStage: 'in-development' }) // provision transition
      .mockRejectedValueOnce(new Error('store down')); // code-review transition

    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('/plans/')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('# Plan') } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      } as Response);
    });

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      if (args[0] === 'status') return { stdout: 'M  src/impl.ts\n' }; // dirty
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${openedPrUrl}\n` };
      return { stdout: '' };
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await dispatchStageHandler(
        { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
        makeProduct(),
        new MockAgentRuntime({ messages: [] }),
        transition as ItemTransitionFn,
        { workdir, githubToken: 'test-token', fetchFn, runGit, runGh },
      );

      expect(result.specialistId).toBe('implementer');
      expect(result.status).toBe('error'); // transition failed → honest error
      expect(result.error).toContain('transition to code-review');
      // prUrl is preserved — PR was already opened before the transition failed
      expect(result.prUrl).toBe(openedPrUrl);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // ── fetchTask: task ingestion into the spec-writer prompt ─────────────────────

  it('spec-writer: injects task into prompt when fetchTask returns a task', async () => {
    let capturedPrompt = '';
    const capturingRuntime = new MockAgentRuntime({
      messages: [],
      sideEffects: async (dir) => {
        await mkdir(join(dir, 'specs'), { recursive: true });
        await writeFile(join(dir, 'specs', 'issue_1.md'), '# Spec\n');
      },
    });
    // Intercept spawn to capture the prompt before the side effect runs
    const originalSpawn = capturingRuntime.spawn.bind(capturingRuntime);
    capturingRuntime.spawn = async (params) => {
      capturedPrompt = params.prompt;
      return originalSpawn(params);
    };

    const fetchTask = vi
      .fn()
      .mockResolvedValue({ title: 'Add dark mode toggle', body: 'Allow switching themes.' });

    await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      capturingRuntime,
      transition as ItemTransitionFn,
      { workdir, fetchTask },
    );

    expect(fetchTask).toHaveBeenCalledWith('issue_1');
    expect(capturedPrompt).toContain('## Task');
    expect(capturedPrompt).toContain('Add dark mode toggle');
    expect(capturedPrompt).toContain('Allow switching themes.');
  });

  it('spec-writer: proceeds without ## Task section when fetchTask returns null', async () => {
    let capturedPrompt = '';
    const capturingRuntime = new MockAgentRuntime({
      messages: [],
      sideEffects: async (dir) => {
        await mkdir(join(dir, 'specs'), { recursive: true });
        await writeFile(join(dir, 'specs', 'issue_1.md'), '# Spec\n');
      },
    });
    const originalSpawn = capturingRuntime.spawn.bind(capturingRuntime);
    capturingRuntime.spawn = async (params) => {
      capturedPrompt = params.prompt;
      return originalSpawn(params);
    };

    const fetchTask = vi.fn().mockResolvedValue(null);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
      makeProduct(),
      capturingRuntime,
      transition as ItemTransitionFn,
      { workdir, fetchTask },
    );

    expect(result.status).toBe('done');
    expect(capturedPrompt).not.toContain('## Task');
  });

  it('spec-writer: proceeds without ## Task section when fetchTask throws (graceful degradation)', async () => {
    let capturedPrompt = '';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const capturingRuntime = new MockAgentRuntime({
      messages: [],
      sideEffects: async (dir) => {
        await mkdir(join(dir, 'specs'), { recursive: true });
        await writeFile(join(dir, 'specs', 'issue_1.md'), '# Spec\n');
      },
    });
    const originalSpawn = capturingRuntime.spawn.bind(capturingRuntime);
    capturingRuntime.spawn = async (params) => {
      capturedPrompt = params.prompt;
      return originalSpawn(params);
    };

    const fetchTask = vi.fn().mockRejectedValue(new Error('tracker unavailable'));

    try {
      const result = await dispatchStageHandler(
        { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'discovery' },
        makeProduct(),
        capturingRuntime,
        transition as ItemTransitionFn,
        { workdir, fetchTask },
      );

      expect(result.status).toBe('done'); // dispatch still succeeds
      expect(capturedPrompt).not.toContain('## Task');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('spec-writer: fetchTask is not called for plan-writer or implementer stages', async () => {
    const fetchTask = vi.fn().mockResolvedValue({ title: 'Some task', body: 'Some body' });

    // plan-writer stage (spec-ready) — fetchTask must NOT be called
    transition.mockResolvedValueOnce({ currentStage: 'plan-draft' }); // plan-writer transition

    const planResult = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-ready' },
      makeProduct(),
      makePlanWriterRuntime('issue_1'),
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', fetchFn: makePlanFetchFn(), fetchTask },
    );

    expect(planResult.specialistId).toBe('plan-writer');
    expect(fetchTask).not.toHaveBeenCalled();
  });
});

// ── dispatchStageHandler > spec/plan-remediator routing (ADR-024) ─────────────

describe('dispatchStageHandler > early-stage remediators', () => {
  let workdir: string;
  let transition: ReturnType<typeof vi.fn>;

  // fetchFn that 404s everything so fetchProductContext degrades gracefully and
  // never reaches the network during routing tests.
  const make404Fetch = (): FetchFn =>
    vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as Response);

  beforeEach(async () => {
    workdir = join(tmpdir(), `dispatcher-rem-${randomUUID()}`);
    await mkdir(workdir, { recursive: true });
    transition = vi.fn().mockResolvedValue({ currentStage: 'spec-draft' });

    vi.clearAllMocks();
    vi.mocked(findArtifactPRUrl).mockResolvedValue(
      'https://github.com/test-org/test-knowledge/pull/7',
    );
    vi.mocked(runEarlyRemediation).mockResolvedValue({
      status: 'done',
      costUsd: 0.04,
      durationMs: 321,
      pushed: true,
      commitSha: 'remsha123',
      prUrl: 'https://github.com/test-org/test-knowledge/pull/7',
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('routes spec-remediator: spawns remediation, returns prUrl, NO stage transition', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      {
        workdir,
        specialistId: 'spec-remediator',
        feedback: 'Tighten the AC.',
        githubToken: 'tok',
        fetchFn: make404Fetch(),
      },
    );

    expect(result.specialistId).toBe('spec-remediator');
    expect(result.status).toBe('done');
    expect(result.prUrl).toBe('https://github.com/test-org/test-knowledge/pull/7');
    expect(result.costUsd).toBe(0.04);
    expect(result.durationMs).toBe(321);
    expect(result.newStage).toBeUndefined();
    expect(transition).not.toHaveBeenCalled();

    expect(findArtifactPRUrl).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'issue_1', kind: 'spec', githubToken: 'tok' }),
      undefined,
    );
    expect(runEarlyRemediation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'spec',
        feedback: 'Tighten the AC.',
        prUrl: 'https://github.com/test-org/test-knowledge/pull/7',
      }),
    );
  });

  it('routes plan-remediator with kind=plan when stage is plan-draft', async () => {
    const product = makeProduct();
    product.workflow.stages_enabled = ['discovery', 'plan-draft', 'released'];
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-draft' },
      product,
      runtime,
      transition as ItemTransitionFn,
      {
        workdir,
        specialistId: 'plan-remediator',
        feedback: 'Split phase 1.',
        githubToken: 'tok',
        fetchFn: make404Fetch(),
      },
    );

    expect(result.specialistId).toBe('plan-remediator');
    expect(result.status).toBe('done');
    expect(findArtifactPRUrl).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'plan' }),
      undefined,
    );
    expect(runEarlyRemediation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan' }));
  });

  it('rejects wrong stage: spec-remediator requires spec-draft', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-ready' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, specialistId: 'spec-remediator', feedback: 'x', githubToken: 'tok' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe(
      "spec-remediator requires currentStage 'spec-draft', got 'plan-ready'",
    );
    expect(findArtifactPRUrl).not.toHaveBeenCalled();
    expect(runEarlyRemediation).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('rejects empty feedback', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, specialistId: 'spec-remediator', feedback: '   ', githubToken: 'tok' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('spec-remediator requires non-empty feedback');
    expect(runEarlyRemediation).not.toHaveBeenCalled();
  });

  it('keeps draft review disabled by default and still requires explicit remediator feedback', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'tok', fetchFn: make404Fetch() },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain("No specialist mapped for stage 'spec-draft'");
    expect(findArtifactPRUrl).not.toHaveBeenCalled();
    expect(runEarlyRemediation).not.toHaveBeenCalled();
    expect(fanoutReviewers).not.toHaveBeenCalled();
  });

  it('keeps plan-draft review disabled when early_loop is false', async () => {
    const product = makeProduct();
    product.review = { early_loop: { enabled: false } };
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-draft' },
      product,
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'tok', fetchFn: make404Fetch() },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain("No specialist mapped for stage 'plan-draft'");
    expect(findArtifactPRUrl).not.toHaveBeenCalled();
    expect(runEarlyRemediation).not.toHaveBeenCalled();
    expect(fanoutReviewers).not.toHaveBeenCalled();
  });

  it('routes spec-draft through the review loop when early_loop is enabled', async () => {
    const product = makeProduct();
    product.review = { early_loop: { enabled: true } };
    vi.mocked(shouldRemediate).mockReturnValue(false);
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      product,
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'tok', fetchFn: make404Fetch() },
    );

    expect(result.specialistId).toBe('spec-draft-reviewer');
    expect(result.status).toBe('done');
    expect(result.prUrl).toBe('https://github.com/test-org/test-knowledge/pull/7');
    expect(findArtifactPRUrl).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'issue_1', kind: 'spec', githubToken: 'tok' }),
      undefined,
    );
    expect(fanoutReviewers).toHaveBeenCalledWith(
      'issue_1',
      product,
      'https://github.com/test-org/test-knowledge/pull/7',
      'tok',
      runtime,
      undefined,
      undefined,
      expect.any(Function),
      { url: 'https://github.com/test-org/test-knowledge', default_branch: 'main', role: 'docs' },
      'helm/spec/issue_1',
    );
    expect(transition).not.toHaveBeenCalled();
    expect(runEarlyRemediation).not.toHaveBeenCalled();
  });

  it('routes plan-draft through the review loop when early_loop is enabled', async () => {
    const product = makeProduct();
    product.review = { early_loop: { enabled: true } };
    vi.mocked(shouldRemediate).mockReturnValue(false);
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'plan-draft' },
      product,
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'tok', fetchFn: make404Fetch() },
    );

    expect(result.specialistId).toBe('plan-draft-reviewer');
    expect(result.status).toBe('done');
    expect(findArtifactPRUrl).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'plan' }),
      undefined,
    );
  });

  it('rejects missing GITHUB_TOKEN', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, specialistId: 'spec-remediator', feedback: 'fix it' }, // no token
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('spec-remediator requires GITHUB_TOKEN');
    expect(findArtifactPRUrl).not.toHaveBeenCalled();
    expect(runEarlyRemediation).not.toHaveBeenCalled();
  });

  it('rejects when no open artifact PR is found', async () => {
    vi.mocked(findArtifactPRUrl).mockResolvedValue(null);
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      {
        workdir,
        specialistId: 'spec-remediator',
        feedback: 'fix it',
        githubToken: 'tok',
        fetchFn: make404Fetch(),
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('no open spec PR found for issue_1 on helm/spec/issue_1');
    expect(runEarlyRemediation).not.toHaveBeenCalled();
  });

  it('propagates error status from runEarlyRemediation (with prUrl preserved)', async () => {
    vi.mocked(runEarlyRemediation).mockResolvedValue({
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      pushed: false,
      prUrl: 'https://github.com/test-org/test-knowledge/pull/7',
      error: 'spec file not found at specs/issue_1.md',
    });
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'spec-draft' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      {
        workdir,
        specialistId: 'spec-remediator',
        feedback: 'fix it',
        githubToken: 'tok',
        fetchFn: make404Fetch(),
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('spec file not found');
    expect(result.prUrl).toBe('https://github.com/test-org/test-knowledge/pull/7');
    expect(transition).not.toHaveBeenCalled();
  });
});

// ── dispatchStageHandler > reviewer-fanout ────────────────────────────────────

describe('dispatchStageHandler > reviewer-fanout', () => {
  let workdir: string;
  let transition: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workdir = join(tmpdir(), `dispatcher-rf-${randomUUID()}`);
    await mkdir(workdir, { recursive: true });
    transition = vi.fn().mockResolvedValue({ currentStage: 'code-review' });

    // Clear accumulated call history, then re-establish default mock behaviour.
    vi.clearAllMocks();
    vi.mocked(findCodePRUrl).mockResolvedValue('https://github.com/test-org/test-repo/pull/42');
    vi.mocked(fanoutReviewers).mockResolvedValue({
      reviewerResults: [],
      prUrl: 'https://github.com/test-org/test-repo/pull/42',
      status: 'done',
      costUsd: 0.03,
      durationMs: 100,
    });
    vi.mocked(shouldRemediate).mockReturnValue(false);
    vi.mocked(buildRemediationParams).mockReturnValue({
      specialistId: 'code-remediator',
      prompt: 'remediate',
      workdir: '/tmp',
      productSlug: 'test-product',
      externalId: 'issue_1',
      permissionMode: 'bypassPermissions',
      timeoutMs: 1000,
    });
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'done',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: true,
      pushed: true,
      commitSha: 'sha789',
    });
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'skipped',
      reason: 'not_configured',
    });
  });

  /** runGit that simulates provisionReviewerWorkspace's clone (creates .git dir). */
  const makeProvisionRunGit = (): RunGit =>
    vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });

  /** Lists leftover reviewer-workspace dirs in tmpdir for this item. */
  const listReviewWorkspaces = async (): Promise<string[]> => {
    const entries = await readdir(tmpdir());
    return entries.filter((e) => e.startsWith('helm-review-issue_1-')).sort();
  };

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('returns error without provision when githubToken is absent', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir }, // no githubToken
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('GITHUB_TOKEN');
    expect(result.specialistId).toBe('reviewer-fanout');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(findCodePRUrl).not.toHaveBeenCalled();
  });

  it('returns error without spawning when PR is not found (findCodePRUrl returns null)', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');

    vi.mocked(findCodePRUrl).mockResolvedValue(null);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain("No open PR found for impl branch of item 'issue_1'");
    expect(result.specialistId).toBe('reviewer-fanout');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(fanoutReviewers).not.toHaveBeenCalled();
  });

  it('happy path with mock runtime: status done, prUrl set, no newStage', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token' },
    );

    expect(result.specialistId).toBe('reviewer-fanout');
    expect(result.status).toBe('done');
    expect(result.prUrl).toBe('https://github.com/test-org/test-repo/pull/42');
    expect(result.costUsd).toBe(0.03);
    expect(result.durationMs).toBe(100);
    expect(result.cyclesCompleted).toBe(1);
    expect(result.escalated).toBeUndefined();
    // No newStage — item stays in code-review
    expect(result.newStage).toBeUndefined();
    expect(transition).not.toHaveBeenCalled();
  });

  it('forwards review-loop escalation fields when external review escalates', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const product: Product = {
      ...makeProduct(),
      review: {
        external: {
          provider: 'haystack',
          haystack: { major_is_blocking: false, poll_interval_sec: 15, timeout_sec: 120 },
        },
      },
    };
    vi.mocked(runExternalReviewIfConfigured).mockResolvedValue({
      status: 'escalate',
      reason: 'haystack pending_timeout',
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      product,
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token' },
    );

    expect(result.status).toBe('error');
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe('external_escalate');
    expect(result.cyclesCompleted).toBe(1);
    expect(result.error).toContain('haystack pending_timeout');
  });

  it('gate inactive: no transition, status from fan-out (item stays in code-review)', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(shouldRemediate).mockReturnValue(false);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token' },
    );

    expect(result.status).toBe('done');
    expect(result.newStage).toBeUndefined();
    expect(transition).not.toHaveBeenCalled();
    expect(handleRemediationResult).not.toHaveBeenCalled();
  });

  it('block-level fan-out failure (no reviewer results): returns error, no gate, no transition', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(fanoutReviewers).mockResolvedValue({
      reviewerResults: [],
      prUrl: 'https://github.com/test-org/test-repo/pull/42',
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: 'Failed to provision reviewer workspaces',
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('provision reviewer workspaces');
    expect(shouldRemediate).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('gate active + remediation done: two transitions, status done, aggregated cost/duration', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(shouldRemediate).mockReturnValueOnce(true);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: makeProvisionRunGit() },
    );

    expect(result.status).toBe('done');
    expect(result.newStage).toBe('code-review');
    // cost = fan-out ×2 (0.03) + remediation (0.02); duration = max(100, 200)
    expect(result.costUsd).toBeCloseTo(0.08, 5);
    expect(result.durationMs).toBe(200);

    // Two transitions: code-review → remediation, then remediation → code-review
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toStage: 'remediation' }),
    );
    expect(transition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toStage: 'code-review' }),
    );

    // Teardown: the remediation workspace AND its sibling artifacts dir
    // (both match the helm-review-issue_1- prefix) are removed (ADR-025 cleanup).
    expect(await listReviewWorkspaces()).toHaveLength(0);
  });

  it('gate active + remediation done BUT fan-out errored: status error (coverage gap surfaced), still transitions back', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(shouldRemediate).mockReturnValueOnce(true);
    // A reviewer gated remediation, but another reviewer failed — the fan-out
    // reports an error even though the gating findings were remediated.
    vi.mocked(fanoutReviewers).mockResolvedValue({
      reviewerResults: [
        {
          kind: 'code',
          status: 'done',
          costUsd: 0.01,
          durationMs: 100,
          commentPosted: true,
          findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          commentBody: '# Code Review: issue_1\n- **HIGH** · x',
        },
        {
          kind: 'security',
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          commentPosted: false,
          error: "Agent finished with status 'error'",
        },
      ],
      prUrl: 'https://github.com/test-org/test-repo/pull/42',
      status: 'error',
      costUsd: 0.01,
      durationMs: 100,
      error: "[security]: Agent finished with status 'error'",
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: makeProvisionRunGit() },
    );

    // Remediation succeeded, but the masked reviewer failure is now surfaced.
    expect(result.status).toBe('error');
    expect(result.error).toContain('reviewer coverage may be incomplete');
    expect(result.error).toContain('security');
    // The transition still stands — the item is genuinely back in code-review.
    expect(result.newStage).toBe('code-review');
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toStage: 'code-review' }),
    );
  });

  it('gate active via code-reviewer HIGH: remediator receives findings from all three reviewer kinds (ADR-025)', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(shouldRemediate).mockReturnValueOnce(true);
    // Fan-out: the code-reviewer reports a HIGH and pushed no source (summary
    // only); security and test also posted comments.
    vi.mocked(fanoutReviewers).mockResolvedValue({
      reviewerResults: [
        {
          kind: 'code',
          status: 'done',
          costUsd: 0.01,
          durationMs: 100,
          commentPosted: true,
          findings: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
          commentBody: '# Code Review: issue_1\n- **HIGH** · tenant email not unique',
        },
        {
          kind: 'security',
          status: 'done',
          costUsd: 0.01,
          durationMs: 100,
          commentPosted: true,
          findings: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
          commentBody: '# Security Review: issue_1\n- **CRITICAL** · SQL injection',
        },
        {
          kind: 'test',
          status: 'done',
          costUsd: 0.01,
          durationMs: 100,
          commentPosted: true,
          findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          commentBody: '# Test Review: issue_1\n- **HIGH** · no edge-case coverage',
        },
      ],
      prUrl: 'https://github.com/test-org/test-repo/pull/42',
      status: 'done',
      costUsd: 0.03,
      durationMs: 100,
    });

    await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: makeProvisionRunGit() },
    );

    // The remediator was dispatched with ALL three reviewers' bodies in
    // findingsByKind (5th positional arg) — the ADR-025 safety net.
    expect(buildRemediationParams).toHaveBeenCalledTimes(1);
    const findingsByKind = vi.mocked(buildRemediationParams).mock.calls[0]![4];
    expect(findingsByKind.get('code')).toContain('tenant email not unique');
    expect(findingsByKind.get('security')).toContain('SQL injection');
    expect(findingsByKind.get('test')).toContain('no edge-case coverage');
  });

  it('gate active + remediation error: transitions to remediation then recovers to code-review', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(shouldRemediate).mockReturnValueOnce(true);
    vi.mocked(handleRemediationResult).mockResolvedValue({
      status: 'error',
      costUsd: 0.02,
      durationMs: 200,
      commentPosted: false,
      pushed: false,
      error: 'Failed to push remediation patches: boom',
    });

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: makeProvisionRunGit() },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('push remediation patches');
    expect(transition).toHaveBeenCalledTimes(3);
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ toStage: 'remediation' }));
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStage: 'code-review',
        triggeredBy: 'specialist:remediation-recovery',
      }),
    );
    expect(result.newStage).toBe('code-review');
    expect(await listReviewWorkspaces()).toHaveLength(0);
  });

  it('gate active + provision fails: status error, NO transition, no agent, no workspace leftover', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');
    vi.mocked(shouldRemediate).mockReturnValueOnce(true);

    // runGit that fails the clone — provisionReviewerWorkspace throws and cleans
    // up its own workspace before propagating.
    const failingRunGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') throw new Error('fatal: Remote branch not found');
      return { stdout: '' };
    });

    const before = await listReviewWorkspaces();

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: failingRunGit },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Failed to provision remediation workspace');
    // Item stays in code-review — never transitioned to remediation.
    expect(transition).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(handleRemediationResult).not.toHaveBeenCalled();
    // No workspace left behind.
    const after = await listReviewWorkspaces();
    expect(after).toEqual(before);
  });

  it('gate active + transition to remediation fails after provision: status error, workspace cleaned up', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    const spawnSpy = vi.spyOn(runtime, 'spawn');
    vi.mocked(shouldRemediate).mockReturnValueOnce(true);
    // First transition (code-review → remediation) rejects after the clone succeeded.
    transition.mockRejectedValueOnce(new Error('transition denied'));

    const before = await listReviewWorkspaces();

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: makeProvisionRunGit() },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Failed to transition to remediation');
    // The transition INTO remediation was attempted; no agent spawned afterwards.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ toStage: 'remediation' }));
    expect(spawnSpy).not.toHaveBeenCalled();
    // The provisioned workspace was removed by the finally block.
    const after = await listReviewWorkspaces();
    expect(after).toEqual(before);
  });

  it('re-runs fan-out after remediation when blockers remain (ADR-036 internal loop)', async () => {
    const runtime = new MockAgentRuntime({ messages: [] });
    vi.mocked(shouldRemediate).mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await dispatchStageHandler(
      { externalId: 'issue_1', productSlug: 'test-product', currentStage: 'code-review' },
      makeProduct(),
      runtime,
      transition as ItemTransitionFn,
      { workdir, githubToken: 'test-token', runGit: makeProvisionRunGit() },
    );

    expect(result.status).toBe('done');
    expect(result.newStage).toBe('code-review');
    expect(fanoutReviewers).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenCalledTimes(2);
  });
});

// ── resolveSpecialistId ─────────────────────────────────────────────────────────

describe('resolveSpecialistId', () => {
  it('maps stage-driven defaults from STAGE_TO_SPECIALIST', () => {
    expect(resolveSpecialistId('discovery')).toBe('spec-writer');
    expect(resolveSpecialistId('spec-ready')).toBe('plan-writer');
    expect(resolveSpecialistId('plan-ready')).toBe('implementer');
    expect(resolveSpecialistId('code-review')).toBe('reviewer-fanout');
  });

  it('returns undefined for a stage with no mapped specialist', () => {
    expect(resolveSpecialistId('spec-draft')).toBeUndefined();
    expect(resolveSpecialistId('released')).toBeUndefined();
  });

  it('lets an explicit specialistId override the stage default', () => {
    // discovery would map to spec-writer, but the override wins.
    expect(resolveSpecialistId('discovery', 'spec-remediator')).toBe('spec-remediator');
    // explicit override wins even on a stage with no default mapping.
    expect(resolveSpecialistId('spec-draft', 'spec-remediator')).toBe('spec-remediator');
  });
});
