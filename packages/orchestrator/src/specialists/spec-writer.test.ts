import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecWriterResult } from './spec-writer.js';
import type { AgentResult } from '../runtime.js';
import type { ItemTransitionFn } from './spec-writer.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const doneResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  status: 'done',
  finalOutput: 'spec written',
  totalCostUsd: 0.01,
  durationMs: 100,
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

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
    // workdir/specs exists but issue_1.md does NOT
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
});
