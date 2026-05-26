import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchStageHandler } from './dispatcher.js';
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

    // Agent reported done but post-completion check fails
    expect(result.status).toBe('done');
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
    // plan-ready → in-development (before agent), in-development → code-review (after PR)
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
});
