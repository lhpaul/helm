import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSpecWriterPrompt, handleSpecWriterResult } from './spec-writer.js';
import type { AgentResult } from '../runtime.js';
import type { ItemTransitionFn, SpecPublishOptions } from './spec-writer.js';
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
    { url: 'https://github.com/test-org/test-repo', default_branch: 'main', role: 'app' },
  ],
  knowledge_repo: { url: 'https://github.com/test-org/knowledge', default_branch: 'main' },
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

const doneResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  status: 'done',
  finalOutput: 'spec written',
  totalCostUsd: 0.01,
  durationMs: 100,
  ...overrides,
});

// ── buildSpecWriterPrompt ─────────────────────────────────────────────────────

describe('buildSpecWriterPrompt', () => {
  it('includes product name and externalId without context', () => {
    const prompt = buildSpecWriterPrompt('issue_1', makeProduct());
    expect(prompt).toContain('Test Product');
    expect(prompt).toContain('issue_1');
    expect(prompt).not.toContain('Product Context');
  });

  it('injects Product Context section when context is provided', () => {
    const prompt = buildSpecWriterPrompt('issue_1', makeProduct(), {
      readme: '# My Product README',
      agentMd: 'Use TypeScript.',
    });
    expect(prompt).toContain('## Product Context');
    expect(prompt).toContain('# My Product README');
    expect(prompt).toContain('Use TypeScript.');
    expect(prompt).toContain('test-product');
    expect(prompt).toContain('discovery → spec-draft → released');
  });

  it('omits README subsection when context has no readme', () => {
    const prompt = buildSpecWriterPrompt('issue_1', makeProduct(), { agentMd: 'instructions' });
    expect(prompt).toContain('## Product Context');
    expect(prompt).not.toContain('### README');
    expect(prompt).toContain('instructions');
  });

  it('omits Agent Instructions subsection when context has no agentMd', () => {
    const prompt = buildSpecWriterPrompt('issue_1', makeProduct(), { readme: '# Readme' });
    expect(prompt).toContain('## Product Context');
    expect(prompt).not.toContain('### Agent Instructions');
    expect(prompt).toContain('# Readme');
  });
});

// ── handleSpecWriterResult ────────────────────────────────────────────────────

describe('handleSpecWriterResult', () => {
  let workdir: string;
  let transition: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workdir = join(tmpdir(), `spec-writer-${randomUUID()}`);
    await mkdir(join(workdir, 'specs'), { recursive: true });
    transition = vi.fn().mockResolvedValue({ currentStage: 'spec-draft' });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('transitions discovery → spec-draft when agent succeeded and spec file exists', async () => {
    await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');

    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('spec-draft');
    expect(transition).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith({
      externalId: 'issue_1',
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
      note: 'Spec written to specs/issue_1.md',
    });
  });

  it('returns error without transitioning when agent status is error', async () => {
    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult({ status: 'error' }),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain("status 'error'");
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns error without transitioning when agent status is cancelled', async () => {
    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult({ status: 'cancelled' }),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toBeDefined();
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns error without transitioning when spec file was not created', async () => {
    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain('not found');
    expect(transition).not.toHaveBeenCalled();
  });

  it('transitions successfully when finalOutput contains a denial note but artifact exists', async () => {
    await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');

    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult({ finalOutput: 'Done.\n[note] 1 permission denial(s) occurred during the run.' }),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('spec-draft');
  });

  it('logs finalOutput server-side and returns a generic error message to caller', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await handleSpecWriterResult(
        'issue_1',
        doneResult({ status: 'error', finalOutput: '[stderr] claude: command not found' }),
        workdir,
        transition as ItemTransitionFn,
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toContain("status 'error'");
      expect(result.error).not.toContain('command not found');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[spec-writer]'),
        expect.objectContaining({ finalOutput: expect.stringContaining('command not found') }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns error when transition throws', async () => {
    await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');
    transition.mockRejectedValue(new Error('state machine rejected'));

    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain('state machine rejected');
  });

  it('handles externalIds with dots and dashes', async () => {
    await writeFile(join(workdir, 'specs', 'HLM-42.md'), '# Spec');

    const result = await handleSpecWriterResult(
      'HLM-42',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(true);
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'HLM-42' }));
  });

  // ── Publish step ───────────────────────────────────────────────────────────

  it('calls publisher and includes prUrl in result when publishOpts provided', async () => {
    await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');

    const mockRunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        // Simulate clone by creating .git in the temp destination dir.
        const dest = args[2]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const mockRunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[1] === 'list') return { stdout: '[]' };
      if (args[1] === 'create') return { stdout: 'https://github.com/test-org/knowledge/pull/1\n' };
      return { stdout: '' };
    });

    const publishOpts: SpecPublishOptions = {
      product: makeProduct(),
      githubToken: 'test-token',
      runGit: mockRunGit,
      runGh: mockRunGh,
    };

    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
      publishOpts,
    );

    expect(result.transitioned).toBe(true);
    expect(result.prUrl).toBe('https://github.com/test-org/knowledge/pull/1');
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringContaining('https://github.com/test-org/knowledge/pull/1'),
      }),
    );
  });

  it('returns error without transitioning when publish step fails', async () => {
    await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mockRunGit = vi.fn().mockRejectedValue(new Error('network timeout'));
      const mockRunGh = vi.fn().mockResolvedValue({ stdout: '[]' });

      const publishOpts: SpecPublishOptions = {
        product: makeProduct(),
        githubToken: 'test-token',
        runGit: mockRunGit,
        runGh: mockRunGh,
      };

      const result = await handleSpecWriterResult(
        'issue_1',
        doneResult(),
        workdir,
        transition as ItemTransitionFn,
        publishOpts,
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toBeDefined();
      expect(transition).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[spec-writer]'),
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('skips publish step and still transitions when publishOpts not provided', async () => {
    await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');

    const result = await handleSpecWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
      // No publishOpts — backward-compatible path
    );

    expect(result.transitioned).toBe(true);
    expect(result.prUrl).toBeUndefined();
  });
});
