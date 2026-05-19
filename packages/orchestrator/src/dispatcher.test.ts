import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchStageHandler } from './dispatcher.js';
import { MockAgentRuntime } from './runtimes/mock.js';
import type { Product } from '@helm/shared';
import type { ItemTransitionFn } from './specialists/spec-writer.js';

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
      { workdir, specialistId: 'plan-writer' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not implemented');
    expect(result.specialistId).toBe('plan-writer');
  });
});
