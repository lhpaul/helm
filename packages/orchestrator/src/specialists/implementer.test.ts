import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildImplementerParams,
  handleImplementerResult,
  IMPLEMENTER_TIMEOUT_MS,
} from './implementer.js';
import type { AgentResult } from '../runtime.js';
import type { ProductContext } from './fetch-product-context.js';
import type { RunGit, RunGh } from './git-helpers.js';
import type { Product, CodeRepo } from '@helm/shared';

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

const makeDoneResult = (): AgentResult => ({
  status: 'done',
  finalOutput: 'Implementation complete.',
  totalCostUsd: 0.05,
  durationMs: 30_000,
});

// ── buildImplementerParams ────────────────────────────────────────────────────

describe('buildImplementerParams', () => {
  it('includes the plan content in the prompt', () => {
    const plan = '## Implementation Plan\n\n- Step 1: add X\n- Step 2: wire Y';
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', plan);
    expect(params.prompt).toContain(plan);
  });

  it('includes the externalId in the prompt', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt).toContain('HLM-99');
  });

  it('includes product context README when provided', () => {
    const context: ProductContext = {
      readme: '# My Product\n\nThis is the README.',
    };
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan', context);
    expect(params.prompt).toContain('# My Product');
    expect(params.prompt).toContain('README');
  });

  it('includes product context agentMd when provided', () => {
    const context: ProductContext = {
      agentMd: 'Run `pnpm test` to execute the test suite.',
    };
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan', context);
    expect(params.prompt).toContain('Run `pnpm test`');
    expect(params.prompt).toContain('Agent Instructions');
  });

  it('includes both README and agentMd when both are provided', () => {
    const context: ProductContext = {
      readme: 'Project readme content.',
      agentMd: 'Agent instructions here.',
    };
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan', context);
    expect(params.prompt).toContain('Project readme content.');
    expect(params.prompt).toContain('Agent instructions here.');
  });

  it('omits the Product Context section when context is not provided', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt).not.toContain('## Product Context');
  });

  it('injects ## Hints section with configured extra_hints', () => {
    const product = makeProduct();
    product.specialists.implementer.extra_hints = [
      "Use Prettier with singleQuote: true and trailingComma: 'all'.",
    ];
    const params = buildImplementerParams('HLM-99', product, '/workspace', '# Plan');
    expect(params.prompt).toContain('## Hints');
    expect(params.prompt).toContain(
      "- Use Prettier with singleQuote: true and trailingComma: 'all'.",
    );
  });

  it('omits the ## Hints section when extra_hints is not configured', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt).not.toContain('## Hints');
  });

  // ── Auto-verification instructions ────────────────────────────────────────

  it('includes an instruction to run tests before finishing', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt.toLowerCase()).toMatch(/test/);
    // Should mention running tests (not just "write tests")
    expect(params.prompt.toLowerCase()).toMatch(/run.*test|test.*run/);
  });

  it('includes an instruction to run the linter', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt.toLowerCase()).toMatch(/lint/);
  });

  it('instructs the agent not to finish until tests and lint pass', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    // Prompt must convey the "repeat until green" requirement
    expect(params.prompt).toMatch(/pass|green|clean/i);
  });

  it('instructs the agent to report failures explicitly rather than claim success', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    // Prompt must warn against false success claims
    expect(params.prompt.toLowerCase()).toMatch(/do not claim|do not.*success|not.*success/i);
  });

  it('mentions common test-command patterns (pnpm, npm, cargo, pytest, go test)', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    // At least some common patterns should be named so the agent knows where to look
    expect(params.prompt).toMatch(/pnpm|npm|cargo|pytest|go test/i);
  });

  it('instructs the agent to look for commands in AGENT.md / CLAUDE.md / README', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt).toMatch(/AGENT\.md|CLAUDE\.md|README/);
  });

  it('distinguishes between pre-existing failures and failures introduced by changes', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.prompt.toLowerCase()).toMatch(/pre-existing|pre.existing|unrelated/i);
  });

  // ── SpawnParams settings ──────────────────────────────────────────────────

  it('sets permissionMode to bypassPermissions', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.permissionMode).toBe('bypassPermissions');
  });

  it('uses the model from the product implementer specialist config', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.model).toBe('claude-opus-4-7');
  });

  it('uses the correct workdir', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/custom/workspace', '# Plan');
    expect(params.workdir).toBe('/custom/workspace');
  });

  it('sets timeoutMs to IMPLEMENTER_TIMEOUT_MS (≥ 15 min)', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.timeoutMs).toBe(IMPLEMENTER_TIMEOUT_MS);
    // Must be at least 15 minutes — implementation + test runs take time
    expect(params.timeoutMs).toBeGreaterThanOrEqual(15 * 60 * 1_000);
  });

  it('sets specialistId to implementer', () => {
    const params = buildImplementerParams('HLM-99', makeProduct(), '/workspace', '# Plan');
    expect(params.specialistId).toBe('implementer');
  });
});

// ── handleImplementerResult ───────────────────────────────────────────────────

describe('handleImplementerResult', () => {
  let workspacePath: string;
  let transition: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `impl-test-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    transition = vi.fn().mockResolvedValue({ currentStage: 'code-review' });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('opens PR and transitions to code-review when agent succeeds', async () => {
    const prUrl = 'https://github.com/test-org/test-repo/pull/42';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/impl.ts\n' };
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${prUrl}\n` };
      return { stdout: '' };
    });

    const result = await handleImplementerResult(
      'HLM-42',
      makeDoneResult(),
      workspacePath,
      makeCodeRepo(),
      transition,
      { product: makeProduct(), githubToken: 'test-tok', runGit, runGh },
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('code-review');
    expect(result.prUrl).toBe(prUrl);
    expect(result.error).toBeUndefined();
    expect(transition).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ toStage: 'code-review', externalId: 'HLM-42' }),
    );
  });

  it('transitions to code-review without prUrl when publishOpts is absent', async () => {
    const result = await handleImplementerResult(
      'HLM-42',
      makeDoneResult(),
      workspacePath,
      makeCodeRepo(),
      transition,
      // no publishOpts — orchestrator skips PR creation
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('code-review');
    expect(result.prUrl).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(transition).toHaveBeenCalledOnce();
  });

  it('returns error without transitioning when agent status is error', async () => {
    const errorResult: AgentResult = { ...makeDoneResult(), status: 'error' };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await handleImplementerResult(
        'HLM-42',
        errorResult,
        workspacePath,
        makeCodeRepo(),
        transition,
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toContain("status 'error'");
      expect(result.newStage).toBeUndefined();
      expect(transition).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns error without transitioning when agent status is cancelled', async () => {
    const cancelledResult: AgentResult = { ...makeDoneResult(), status: 'cancelled' };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await handleImplementerResult(
        'HLM-42',
        cancelledResult,
        workspacePath,
        makeCodeRepo(),
        transition,
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toContain("status 'cancelled'");
      expect(transition).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns error without transitioning when openCodePR returns empty prUrl (no changes)', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: '' }; // clean — no changes
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await handleImplementerResult(
        'HLM-42',
        makeDoneResult(),
        workspacePath,
        makeCodeRepo(),
        transition,
        { product: makeProduct(), githubToken: 'test-tok', runGit, runGh },
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toContain('no file changes');
      expect(result.prUrl).toBeUndefined();
      expect(transition).not.toHaveBeenCalled();
      // gh must not have been called — no changes means no PR attempt
      expect(runGh).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns error without transitioning when openCodePR throws (push failure)', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/impl.ts\n' };
      if (args[0] === 'push') throw new Error('push rejected: not authorized');
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await handleImplementerResult(
        'HLM-42',
        makeDoneResult(),
        workspacePath,
        makeCodeRepo(),
        transition,
        { product: makeProduct(), githubToken: 'test-tok', runGit, runGh },
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toContain('Failed to open code PR');
      expect(transition).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns error with prUrl preserved when transition to code-review fails', async () => {
    const prUrl = 'https://github.com/test-org/test-repo/pull/42';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/impl.ts\n' };
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${prUrl}\n` };
      return { stdout: '' };
    });
    // Simulate a store/network error during transition
    transition.mockRejectedValue(new Error('store unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await handleImplementerResult(
        'HLM-42',
        makeDoneResult(),
        workspacePath,
        makeCodeRepo(),
        transition,
        { product: makeProduct(), githubToken: 'test-tok', runGit, runGh },
      );

      expect(result.transitioned).toBe(false);
      expect(result.error).toContain('transition to code-review');
      // PR was already opened — prUrl must be preserved so callers can surface it
      expect(result.prUrl).toBe(prUrl);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
