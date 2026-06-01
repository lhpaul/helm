import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPlanRemediatorParams,
  buildPlanRemediatorPrompt,
  runPlanRemediation,
} from './plan-remediator.js';
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
    stages_enabled: ['discovery', 'plan-draft', 'released'],
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
    'plan-remediator': { runtime: 'claude_code', model: 'claude-haiku-4-5' },
    'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
});

const PR_URL = 'https://github.com/test-org/test-knowledge/pull/9';
const CURRENT_PLAN = '# HLM-42 — Plan\n\n## Steps\n1. Original step.';
const FEEDBACK = 'Split step 1 into migration + backfill phases.';

// ── buildPlanRemediatorPrompt / Params ─────────────────────────────────────────

describe('buildPlanRemediatorParams', () => {
  const product = makeProduct();

  it('includes the ## Current Plan and ## Feedback sections with their content', () => {
    const prompt = buildPlanRemediatorPrompt('HLM-42', product, CURRENT_PLAN, FEEDBACK);
    expect(prompt).toContain('## Current Plan');
    expect(prompt).toContain('Original step.');
    expect(prompt).toContain('## Feedback');
    expect(prompt).toContain(FEEDBACK);
  });

  it('references the flat plan path and instructs in-place editing (no new PR)', () => {
    const prompt = buildPlanRemediatorPrompt('HLM-42', product, CURRENT_PLAN, FEEDBACK);
    expect(prompt).toContain('plans/HLM-42.md');
    expect(prompt).toContain('do NOT regenerate the plan from scratch');
    expect(prompt).toContain('Do NOT commit, push, or open a new PR');
  });

  it('sets specialistId, model, acceptEdits permission, and the shared timeout', () => {
    const params = buildPlanRemediatorParams('HLM-42', product, '/tmp/ws', CURRENT_PLAN, FEEDBACK);
    expect(params.specialistId).toBe('plan-remediator');
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.permissionMode).toBe('acceptEdits');
    expect(params.timeoutMs).toBe(EARLY_REMEDIATION_TIMEOUT_MS);
  });
});

// ── runPlanRemediation ──────────────────────────────────────────────────────────

function makeRunGit(opts: { dirty: boolean; calls: string[][] }): RunGit {
  return vi.fn().mockImplementation(async (args: string[]) => {
    opts.calls.push([...args]);
    if (args[0] === 'clone') {
      const ws = args[args.length - 1]!;
      await mkdir(join(ws, 'plans'), { recursive: true });
      await writeFile(join(ws, 'plans', 'HLM-42.md'), CURRENT_PLAN);
      return { stdout: '' };
    }
    if (args[0] === 'status') return { stdout: opts.dirty ? 'M  plans/HLM-42.md\n' : '' };
    if (args[0] === 'rev-parse') return { stdout: 'plansha456\n' };
    return { stdout: '' };
  });
}

describe('runPlanRemediation', () => {
  it('happy path: spawns agent, pushes edits to helm/plan/<id>, returns same prUrl', async () => {
    const calls: string[][] = [];
    const runGit = makeRunGit({ dirty: true, calls });
    const runtime = new MockAgentRuntime({
      messages: [{ role: 'agent', content: 'Editing plan…', timestamp: new Date().toISOString() }],
      sideEffects: async (workdir) => {
        await writeFile(join(workdir, 'plans', 'HLM-42.md'), `${CURRENT_PLAN}\n2. Backfill.`);
      },
    });

    const result = await runPlanRemediation({
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
    expect(result.commitSha).toBe('plansha456');
    expect(result.prUrl).toBe(PR_URL);

    const cloneCall = calls.find((a) => a[0] === 'clone');
    expect(cloneCall?.join(' ')).toContain('helm/plan/HLM-42');
    const pushCall = calls.find((a) => a[0] === 'push');
    expect(pushCall?.join(' ')).toContain('helm/plan/HLM-42:helm/plan/HLM-42');
    expect(pushCall?.join(' ')).not.toContain('--force');
  });

  it('missing artifact: returns error when the branch has no plan file', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      calls.push([...args]);
      return { stdout: '' };
    });
    const runtime = new MockAgentRuntime({ messages: [] });

    const result = await runPlanRemediation({
      externalId: 'HLM-42',
      product: makeProduct(),
      prUrl: PR_URL,
      feedback: FEEDBACK,
      githubToken: 'test-token',
      runtime,
      runGit,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('plan file not found');
  });
});
