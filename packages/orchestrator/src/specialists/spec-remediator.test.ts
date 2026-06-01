import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSpecRemediatorParams,
  buildSpecRemediatorPrompt,
  runSpecRemediation,
} from './spec-remediator.js';
import { EARLY_REMEDIATION_TIMEOUT_MS } from './early-remediator.js';
import { MockAgentRuntime } from '../runtimes/mock.js';
import type { RunGit } from './git-helpers.js';
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
  knowledge_repo: { url: 'https://github.com/test-org/test-knowledge', default_branch: 'main' },
  workflow: {
    stages_enabled: ['discovery', 'spec-draft', 'released'],
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
    'spec-remediator': { runtime: 'claude_code', model: 'claude-haiku-4-5' },
    'plan-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
});

const PR_URL = 'https://github.com/test-org/test-knowledge/pull/7';
const CURRENT_SPEC = '# HLM-42 — Specification\n\n## Context\nOriginal context.';
const FEEDBACK = 'Add an explicit Acceptance Criteria section with measurable items.';

// ── buildSpecRemediatorPrompt / Params ─────────────────────────────────────────

describe('buildSpecRemediatorParams', () => {
  const product = makeProduct();

  it('includes the ## Current Spec and ## Feedback sections with their content', () => {
    const prompt = buildSpecRemediatorPrompt('HLM-42', product, CURRENT_SPEC, FEEDBACK);
    expect(prompt).toContain('## Current Spec');
    expect(prompt).toContain('Original context.');
    expect(prompt).toContain('## Feedback');
    expect(prompt).toContain(FEEDBACK);
  });

  it('references the flat spec path and instructs in-place editing (no new PR)', () => {
    const prompt = buildSpecRemediatorPrompt('HLM-42', product, CURRENT_SPEC, FEEDBACK);
    expect(prompt).toContain('specs/HLM-42.md');
    expect(prompt).toContain('do NOT regenerate the spec from scratch');
    expect(prompt).toContain('Do NOT commit, push, or open a new PR');
  });

  it('sets specialistId, model, acceptEdits permission, and the shared timeout', () => {
    const params = buildSpecRemediatorParams('HLM-42', product, '/tmp/ws', CURRENT_SPEC, FEEDBACK);
    expect(params.specialistId).toBe('spec-remediator');
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.permissionMode).toBe('acceptEdits');
    expect(params.timeoutMs).toBe(EARLY_REMEDIATION_TIMEOUT_MS);
  });

  it('injects ## Hints from the spec-remediator extra_hints', () => {
    const p = makeProduct();
    p.specialists['spec-remediator'].extra_hints = ['Keep acceptance criteria testable.'];
    const prompt = buildSpecRemediatorPrompt('HLM-42', p, CURRENT_SPEC, FEEDBACK);
    expect(prompt).toContain('## Hints');
    expect(prompt).toContain('- Keep acceptance criteria testable.');
  });
});

// ── runSpecRemediation ──────────────────────────────────────────────────────────

/**
 * Builds a RunGit mock that emulates a clone by writing the current spec into the
 * cloned workspace (last clone arg = workspace path), reports the tree dirty, and
 * captures all invocations for assertions.
 */
function makeRunGit(opts: { dirty: boolean; calls: string[][] }): RunGit {
  return vi.fn().mockImplementation(async (args: string[]) => {
    opts.calls.push([...args]);
    if (args[0] === 'clone') {
      const ws = args[args.length - 1]!;
      await mkdir(join(ws, 'specs'), { recursive: true });
      await writeFile(join(ws, 'specs', 'HLM-42.md'), CURRENT_SPEC);
      return { stdout: '' };
    }
    if (args[0] === 'status') return { stdout: opts.dirty ? 'M  specs/HLM-42.md\n' : '' };
    if (args[0] === 'rev-parse') return { stdout: 'specsha123\n' };
    return { stdout: '' };
  });
}

describe('runSpecRemediation', () => {
  it('happy path: spawns agent, pushes edits to helm/spec/<id>, returns same prUrl', async () => {
    const calls: string[][] = [];
    const runGit = makeRunGit({ dirty: true, calls });
    const runtime = new MockAgentRuntime({
      messages: [{ role: 'agent', content: 'Editing spec…', timestamp: new Date().toISOString() }],
      sideEffects: async (workdir) => {
        await writeFile(
          join(workdir, 'specs', 'HLM-42.md'),
          `${CURRENT_SPEC}\n\n## Acceptance Criteria`,
        );
      },
    });

    const result = await runSpecRemediation({
      externalId: 'HLM-42',
      product: makeProduct(),
      prUrl: PR_URL,
      feedback: FEEDBACK,
      githubToken: 'test-token',
      runtime,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(result.pushed).toBe(true);
    expect(result.commitSha).toBe('specsha123');
    expect(result.prUrl).toBe(PR_URL);

    // Cloned the spec branch and pushed back to it (fast-forward, no --force).
    const cloneCall = calls.find((a) => a[0] === 'clone');
    expect(cloneCall?.join(' ')).toContain('helm/spec/HLM-42');
    const pushCall = calls.find((a) => a[0] === 'push');
    expect(pushCall?.join(' ')).toContain('helm/spec/HLM-42:helm/spec/HLM-42');
    expect(pushCall?.join(' ')).not.toContain('--force');
  });

  it('no changes: returns done with pushed=false (agent left file untouched)', async () => {
    const calls: string[][] = [];
    const runGit = makeRunGit({ dirty: false, calls });
    const runtime = new MockAgentRuntime({
      messages: [
        { role: 'agent', content: 'No change needed', timestamp: new Date().toISOString() },
      ],
    });

    const result = await runSpecRemediation({
      externalId: 'HLM-42',
      product: makeProduct(),
      prUrl: PR_URL,
      feedback: FEEDBACK,
      githubToken: 'test-token',
      runtime,
      runGit,
    });

    expect(result.status).toBe('done');
    expect(result.pushed).toBe(false);
    expect(calls.some((a) => a[0] === 'push')).toBe(false);
  });

  it('agent error: returns error, no push attempted', async () => {
    const calls: string[][] = [];
    const runGit = makeRunGit({ dirty: true, calls });
    const runtime = new MockAgentRuntime({
      messages: [{ role: 'agent', content: 'boom', timestamp: new Date().toISOString() }],
      outcome: 'error',
    });

    const result = await runSpecRemediation({
      externalId: 'HLM-42',
      product: makeProduct(),
      prUrl: PR_URL,
      feedback: FEEDBACK,
      githubToken: 'test-token',
      runtime,
      runGit,
    });

    expect(result.status).toBe('error');
    expect(result.pushed).toBe(false);
    expect(calls.some((a) => a[0] === 'push')).toBe(false);
  });

  it('missing artifact: returns error when the branch has no spec file', async () => {
    const calls: string[][] = [];
    // Clone that does NOT write the spec file.
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      calls.push([...args]);
      return { stdout: '' };
    });
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await runSpecRemediation({
      externalId: 'HLM-42',
      product: makeProduct(),
      prUrl: PR_URL,
      feedback: FEEDBACK,
      githubToken: 'test-token',
      runtime,
      runGit,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('spec file not found');
    expect(result.prUrl).toBe(PR_URL);
  });

  it('does not leak the token in clone-failure errors', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      calls.push([...args]);
      if (args[0] === 'clone') {
        throw new Error(
          'fatal: could not read from https://x-access-token:test-token@github.com/...',
        );
      }
      return { stdout: '' };
    });
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await runSpecRemediation({
      externalId: 'HLM-42',
      product: makeProduct(),
      prUrl: PR_URL,
      feedback: FEEDBACK,
      githubToken: 'test-token',
      runtime,
      runGit,
    });

    expect(result.status).toBe('error');
    expect(result.error).not.toContain('test-token');
    expect(result.error).toContain('***');
  });
});
