import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildRemediationParams,
  handleRemediationResult,
  REMEDIATION_TIMEOUT_MS,
} from './remediation.js';
import type { ReviewerKind } from './reviewer-fanout.js';
import type { AgentResult } from '../runtime.js';
import type { RunGit, RunGh } from './git-helpers.js';
import type { CodeRepo, Product } from '@helm/shared';

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
    stages_enabled: ['discovery', 'code-review', 'remediation', 'released'],
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
    'code-remediator': { runtime: 'claude_code', model: 'claude-haiku-4-5' },
  },
});

const makeCodeRepo = (): CodeRepo => ({
  url: 'https://github.com/test-org/test-repo',
  default_branch: 'main',
  role: 'app',
});

const PR_URL = 'https://github.com/test-org/test-repo/pull/42';

const makeAgentResult = (status: AgentResult['status'] = 'done'): AgentResult => ({
  status,
  finalOutput: status === 'done' ? 'Remediation complete.' : '',
  totalCostUsd: 0.02,
  durationMs: 200,
});

// ── buildRemediationParams ──────────────────────────────────────────────────

describe('buildRemediationParams', () => {
  const product = makeProduct();

  const findingsByKind = (): Map<ReviewerKind, string> =>
    new Map<ReviewerKind, string>([
      ['security', '# Security Review\n- **CRITICAL** · SQL injection in query'],
      ['test', '# Test Review\n- **HIGH** · missing edge-case coverage'],
    ]);

  it('includes the security and test review bodies in the prompt', () => {
    const params = buildRemediationParams('HLM-42', product, '/tmp/ws', PR_URL, findingsByKind());
    expect(params.prompt).toContain('## Security Review');
    expect(params.prompt).toContain('SQL injection in query');
    expect(params.prompt).toContain('## Test Review');
    expect(params.prompt).toContain('missing edge-case coverage');
  });

  it('includes the PR URL and externalId', () => {
    const params = buildRemediationParams('HLM-42', product, '/tmp/ws', PR_URL, findingsByKind());
    expect(params.prompt).toContain(PR_URL);
    expect(params.prompt).toContain('HLM-42');
  });

  it('instructs the agent to write remediation.md and not push', () => {
    const params = buildRemediationParams('HLM-42', product, '/tmp/ws', PR_URL, findingsByKind());
    expect(params.prompt).toContain('remediation.md');
    expect(params.prompt).toContain('Deferred');
    expect(params.prompt).toContain('Do not commit or push');
  });

  it('uses bypassPermissions, REMEDIATION_TIMEOUT_MS, and the remediation model', () => {
    const params = buildRemediationParams('HLM-42', product, '/tmp/ws', PR_URL, findingsByKind());
    expect(params.permissionMode).toBe('bypassPermissions');
    expect(params.timeoutMs).toBe(REMEDIATION_TIMEOUT_MS);
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.specialistId).toBe('code-remediator');
  });

  it('REMEDIATION_TIMEOUT_MS sits between reviewer (10m) and implementer (20m)', () => {
    expect(REMEDIATION_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1_000);
    expect(REMEDIATION_TIMEOUT_MS).toBeLessThan(20 * 60 * 1_000);
  });

  it('injects ## Hints section with the remediation specialist’s extra_hints', () => {
    const p = makeProduct();
    p.specialists['code-remediator'].extra_hints = [
      'Prefer parameterized queries over string interpolation.',
    ];
    const params = buildRemediationParams('HLM-42', p, '/tmp/ws', PR_URL, findingsByKind());
    expect(params.prompt).toContain('## Hints');
    expect(params.prompt).toContain('- Prefer parameterized queries over string interpolation.');
  });

  it('omits the ## Hints section when extra_hints is not configured', () => {
    const params = buildRemediationParams(
      'HLM-42',
      makeProduct(),
      '/tmp/ws',
      PR_URL,
      findingsByKind(),
    );
    expect(params.prompt).not.toContain('## Hints');
  });
});

// ── handleRemediationResult ──────────────────────────────────────────────────

describe('handleRemediationResult', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `test-remediation-ws-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  });

  it('success: reads remediation.md, pushes, posts comment with SHA footer', async () => {
    await writeFile(
      join(workspacePath, 'remediation.md'),
      '# Remediation: HLM-42\n\n## Applied\n- Fixed SQL injection (CRITICAL)',
    );

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/db.ts\n' }; // dirty
      if (args[0] === 'rev-parse') return { stdout: 'sha789\n' };
      return { stdout: '' };
    });
    const capturedBodies: string[] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      const i = args.indexOf('--body');
      if (i !== -1 && args[i + 1]) capturedBodies.push(args[i + 1]!);
      return { stdout: '' };
    });

    const result = await handleRemediationResult(
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    expect(result.status).toBe('done');
    expect(result.commentPosted).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commitSha).toBe('sha789');
    expect(capturedBodies.some((b) => b.includes('sha789'))).toBe(true);
  });

  it('uses a remediation commit message when pushing', async () => {
    await writeFile(join(workspacePath, 'remediation.md'), '# Remediation: HLM-42');
    const capturedArgs: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'status') return { stdout: 'M  src/db.ts\n' };
      if (args[0] === 'rev-parse') return { stdout: 'sha789\n' };
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockResolvedValue({ stdout: '' });

    await handleRemediationResult(
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    const commitArgs = capturedArgs.find((a) => a[0] === 'commit');
    expect(commitArgs!.join(' ')).toContain('chore(remediation): apply fixes for HLM-42');
  });

  it('no changes: push returns pushed:false; comment still posted without footer', async () => {
    await writeFile(join(workspacePath, 'remediation.md'), '# Remediation: HLM-42\n\nNo fixes.');

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: '' }; // clean
      return { stdout: '' };
    });
    const capturedBodies: string[] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      const i = args.indexOf('--body');
      if (i !== -1 && args[i + 1]) capturedBodies.push(args[i + 1]!);
      return { stdout: '' };
    });

    const result = await handleRemediationResult(
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    expect(result.status).toBe('done');
    expect(result.pushed).toBe(false);
    expect(result.commentPosted).toBe(true);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).not.toContain('commit `');
  });

  it('agent error: no push, no comment', async () => {
    const runGit: RunGit = vi.fn();
    const runGh: RunGh = vi.fn();

    const result = await handleRemediationResult(
      'HLM-42',
      makeAgentResult('error'),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    expect(result.status).toBe('error');
    expect(result.commentPosted).toBe(false);
    expect(result.pushed).toBe(false);
    expect(runGit).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it('push fails after read: status error, no comment', async () => {
    await writeFile(join(workspacePath, 'remediation.md'), '# Remediation: HLM-42');
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/db.ts\n' };
      if (args[0] === 'rev-parse') return { stdout: 'sha789\n' };
      if (args[0] === 'push') throw new Error('fatal: remote rejected');
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockResolvedValue({ stdout: '' });

    const result = await handleRemediationResult(
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    expect(result.status).toBe('error');
    expect(result.commentPosted).toBe(false);
    expect(result.error).toContain('push');
    expect(runGh).not.toHaveBeenCalled();
  });

  it('comment fails after push: status error, pushed true', async () => {
    await writeFile(join(workspacePath, 'remediation.md'), '# Remediation: HLM-42');
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/db.ts\n' };
      if (args[0] === 'rev-parse') return { stdout: 'sha789\n' };
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockRejectedValue(new Error('gh: rate limit exceeded'));

    const result = await handleRemediationResult(
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    expect(result.status).toBe('error');
    expect(result.commentPosted).toBe(false);
    expect(result.pushed).toBe(true);
    expect(result.error).toContain('Failed to post PR comment');
  });

  it('missing remediation.md: falls back to placeholder, still posts comment', async () => {
    // No remediation.md written.
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: '' }; // clean
      return { stdout: '' };
    });
    const capturedBodies: string[] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      const i = args.indexOf('--body');
      if (i !== -1 && args[i + 1]) capturedBodies.push(args[i + 1]!);
      return { stdout: '' };
    });

    const result = await handleRemediationResult(
      'HLM-42',
      makeAgentResult(),
      workspacePath,
      PR_URL,
      'test-token',
      makeCodeRepo(),
      runGit,
      runGh,
    );

    expect(result.status).toBe('done');
    expect(result.commentPosted).toBe(true);
    expect(capturedBodies[0]).toContain('No remediation.md was produced');
  });
});
