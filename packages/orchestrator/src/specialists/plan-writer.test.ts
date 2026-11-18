import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanWriterPrompt, handlePlanWriterResult } from './plan-writer.js';
import type { AgentResult } from '../runtime.js';
import type { PlanPublishOptions } from './plan-writer.js';
import type { ItemTransitionFn } from './spec-writer.js';
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
    stages_enabled: ['discovery', 'spec-draft', 'spec-ready', 'plan-draft', 'released'],
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

const SAMPLE_SPEC = `# issue_1 — Specification

## Context
Add user authentication to the API.

## Acceptance Criteria
- Users can register with email + password
- Users can log in and receive a JWT

## Technical Notes
Use bcrypt for password hashing.`;

const doneResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  status: 'done',
  finalOutput: 'plan written',
  totalCostUsd: 0.02,
  durationMs: 200,
  ...overrides,
});

// ── buildPlanWriterPrompt ─────────────────────────────────────────────────────

describe('buildPlanWriterPrompt', () => {
  it('includes product name, externalId, and spec content', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC);
    expect(prompt).toContain('Test Product');
    expect(prompt).toContain('issue_1');
    expect(prompt).toContain('Add user authentication to the API');
  });

  it('does not include Product Context section when no context is provided', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC);
    expect(prompt).not.toContain('## Product Context');
  });

  it('injects Product Context section when context has readme', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC, {
      readme: '# MyApp README',
    });
    expect(prompt).toContain('## Product Context');
    expect(prompt).toContain('# MyApp README');
  });

  it('injects Product Context section when context has agentMd', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC, {
      agentMd: 'Use TypeScript strict mode.',
    });
    expect(prompt).toContain('## Product Context');
    expect(prompt).toContain('Use TypeScript strict mode.');
  });

  it('does not inject Product Context section when context has neither readme nor agentMd', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC, {});
    expect(prompt).not.toContain('## Product Context');
  });

  it('references plans/ as the output directory', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC);
    expect(prompt).toContain('plans/issue_1.md');
  });

  it('instructs the agent to write the file without asking for confirmation', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC);
    expect(prompt).toContain('Do not ask for confirmation before writing');
    // No contradictory "confirm once" step
    expect(prompt).not.toContain('Confirm once the file is written');
  });

  it('positions the spec before the output instructions', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC);
    const specIndex = prompt.indexOf('Add user authentication');
    const plansIndex = prompt.indexOf('plans/issue_1.md');
    expect(specIndex).toBeGreaterThan(0);
    expect(plansIndex).toBeGreaterThan(specIndex);
  });

  it('injects ## Hints section with configured extra_hints', () => {
    const product = makeProduct();
    product.specialists['plan-writer'].extra_hints = [
      'Pin exact versions for runtime deps.',
      'List every file to touch.',
    ];
    const prompt = buildPlanWriterPrompt('issue_1', product, SAMPLE_SPEC);
    expect(prompt).toContain('## Hints');
    expect(prompt).toContain('- Pin exact versions for runtime deps.');
    expect(prompt).toContain('- List every file to touch.');
  });

  it('omits ## Hints section when extra_hints is not configured', () => {
    const prompt = buildPlanWriterPrompt('issue_1', makeProduct(), SAMPLE_SPEC);
    expect(prompt).not.toContain('## Hints');
  });
});

// ── handlePlanWriterResult ────────────────────────────────────────────────────

describe('handlePlanWriterResult', () => {
  let workdir: string;
  let transition: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workdir = join(tmpdir(), `plan-writer-${randomUUID()}`);
    await mkdir(join(workdir, 'plans'), { recursive: true });
    transition = vi.fn().mockResolvedValue({ currentStage: 'plan-draft' });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('transitions spec-ready → plan-draft when agent succeeded and plan file exists', async () => {
    await writeFile(join(workdir, 'plans', 'issue_1.md'), '# Plan');

    const result = await handlePlanWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('plan-draft');
    expect(transition).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith({
      externalId: 'issue_1',
      toStage: 'plan-draft',
      triggeredBy: 'agent:plan-writer',
      note: 'Plan written to plans/issue_1.md',
    });
  });

  it('returns error without transitioning when agent status is error', async () => {
    const result = await handlePlanWriterResult(
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
    const result = await handlePlanWriterResult(
      'issue_1',
      doneResult({ status: 'cancelled' }),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toBeDefined();
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns error without transitioning when plan file was not created', async () => {
    const result = await handlePlanWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain('not found');
    expect(transition).not.toHaveBeenCalled();
  });

  it('error message does not expose finalOutput (may contain spec content)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // No plan file written — triggers "plan file missing" branch which logs metadata only.
      const result = await handlePlanWriterResult(
        'issue_1',
        doneResult({
          status: 'done',
          finalOutput: 'SECRET_SPEC_CONTENT — agent got confused',
        }),
        workdir,
        transition as ItemTransitionFn,
      );

      expect(result.error).not.toContain('SECRET_SPEC_CONTENT');
      // console.error logs metadata only — raw finalOutput must not appear.
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[plan-writer]'),
        expect.objectContaining({
          hasAgentFinalOutput: true,
          agentFinalOutputChars: expect.any(Number),
        }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns error when transition throws', async () => {
    await writeFile(join(workdir, 'plans', 'issue_1.md'), '# Plan');
    transition.mockRejectedValue(new Error('state machine rejected'));

    const result = await handlePlanWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain('state machine rejected');
  });

  it('handles externalIds with dots and dashes', async () => {
    await writeFile(join(workdir, 'plans', 'HLM-42.md'), '# Plan');

    const result = await handlePlanWriterResult(
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
    await writeFile(join(workdir, 'plans', 'issue_1.md'), '# Plan');

    const mockRunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[2]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });
    const mockRunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[1] === 'list') return { stdout: '[]' };
      if (args[1] === 'create') return { stdout: 'https://github.com/test-org/knowledge/pull/2\n' };
      return { stdout: '' };
    });

    const publishOpts: PlanPublishOptions = {
      product: makeProduct(),
      githubToken: 'test-token',
      runGit: mockRunGit,
      runGh: mockRunGh,
    };

    const result = await handlePlanWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
      publishOpts,
    );

    expect(result.transitioned).toBe(true);
    expect(result.prUrl).toBe('https://github.com/test-org/knowledge/pull/2');
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringContaining('https://github.com/test-org/knowledge/pull/2'),
      }),
    );
  });

  it('returns error without transitioning when publish step fails', async () => {
    await writeFile(join(workdir, 'plans', 'issue_1.md'), '# Plan');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mockRunGit = vi.fn().mockRejectedValue(new Error('network timeout'));
      const mockRunGh = vi.fn().mockResolvedValue({ stdout: '[]' });

      const publishOpts: PlanPublishOptions = {
        product: makeProduct(),
        githubToken: 'test-token',
        runGit: mockRunGit,
        runGh: mockRunGh,
      };

      const result = await handlePlanWriterResult(
        'issue_1',
        doneResult(),
        workdir,
        transition as ItemTransitionFn,
        publishOpts,
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toBeDefined();
      expect(transition).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('skips publish and still transitions when publishOpts not provided', async () => {
    await writeFile(join(workdir, 'plans', 'issue_1.md'), '# Plan');

    const result = await handlePlanWriterResult(
      'issue_1',
      doneResult(),
      workdir,
      transition as ItemTransitionFn,
    );

    expect(result.transitioned).toBe(true);
    expect(result.prUrl).toBeUndefined();
  });
});
