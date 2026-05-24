import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishSpecToPR } from './spec-publisher.js';
import type { PublishSpecOpts, RunGit, RunGh } from './spec-publisher.js';
import type { Product } from '@helm/shared';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeProduct = (): Product => ({
  helm_version: '0',
  product: { slug: 'my-product', name: 'My Product' },
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

// ── Mock runners ──────────────────────────────────────────────────────────────

/**
 * Builds a mock runGit that simulates git operations on the real local
 * filesystem.  `clone <url> <dest>` creates a `.git` marker inside `dest`
 * (which publishSpecToPR pre-creates); all other commands are no-ops.
 *
 * Since publishSpecToPR always clones to a fresh temp directory (known only
 * at call time), the destination is read directly from the args array rather
 * than being injected as a parameter.
 */
function makeRunGit(): RunGit {
  return vi.fn().mockImplementation(async (args: string[]) => {
    if (args[0] === 'clone') {
      const dest = args[2]!;
      await mkdir(join(dest, '.git'), { recursive: true });
    }
    return { stdout: '' };
  });
}

/** Builds a mock runGh that returns an empty PR list (no existing PR). */
function makeRunGh(prListResult: { url: string }[] = []): RunGh {
  return vi.fn().mockImplementation(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return { stdout: JSON.stringify(prListResult) };
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      return { stdout: 'https://github.com/test-org/knowledge/pull/42\n' };
    }
    return { stdout: '' };
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let specPath: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `spec-publisher-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });

  // Create a spec file to publish
  const specsDir = join(tmpDir, 'workdir', 'specs');
  await mkdir(specsDir, { recursive: true });
  specPath = join(specsDir, 'issue_1.md');
  await writeFile(specPath, '# issue_1 — Specification\n');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeOpts = (overrides?: Partial<PublishSpecOpts>): PublishSpecOpts => ({
  externalId: 'issue_1',
  product: makeProduct(),
  specPath,
  githubToken: 'test-token',
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('publishSpecToPR', () => {
  it('clones repo, copies spec, commits, pushes, and creates PR', async () => {
    const runGit = makeRunGit();
    const runGh = makeRunGh();

    const result = await publishSpecToPR(makeOpts(), runGit, runGh);

    expect(result.prUrl).toBe('https://github.com/test-org/knowledge/pull/42');

    // git was called with clone, checkout -B, add, commit, push
    // mock.calls[i] = [args, opts] since runGit takes two parameters
    const gitCalls = (runGit as ReturnType<typeof vi.fn>).mock.calls as [string[], unknown][];
    expect(gitCalls.some(([args]) => args[0] === 'clone')).toBe(true);
    expect(gitCalls.some(([args]) => args[0] === 'checkout' && args[1] === '-B')).toBe(true);
    expect(gitCalls.some(([args]) => args[0] === 'add')).toBe(true);
    expect(gitCalls.some(([args]) => args[0] === 'commit')).toBe(true);
    expect(gitCalls.some(([args]) => args[0] === 'push')).toBe(true);
  });

  it('reuses existing open PR without creating a duplicate', async () => {
    const runGit = makeRunGit();
    const existingPrUrl = 'https://github.com/test-org/knowledge/pull/7';
    const runGh = makeRunGh([{ url: existingPrUrl }]);

    const result = await publishSpecToPR(makeOpts(), runGit, runGh);

    expect(result.prUrl).toBe(existingPrUrl);

    // mock.calls[i] = [args, opts]
    const ghCalls = (runGh as ReturnType<typeof vi.fn>).mock.calls as [string[], unknown][];
    // pr create must NOT have been called
    expect(ghCalls.some(([args]) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });

  it('throws with a descriptive message when clone fails', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') throw new Error('Authentication failed');
      return { stdout: '' };
    });
    const runGh = makeRunGh();

    await expect(publishSpecToPR(makeOpts(), runGit, runGh)).rejects.toThrow(
      /Failed to clone knowledge repo.*Authentication failed/,
    );
  });

  it('throws with a descriptive message when push fails', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[2]!;
        await mkdir(join(dest, '.git'), { recursive: true });
        return { stdout: '' };
      }
      if (args[0] === 'push') throw new Error('remote: Permission to repo denied');
      return { stdout: '' };
    });
    const runGh = makeRunGh();

    await expect(publishSpecToPR(makeOpts(), runGit, runGh)).rejects.toThrow(
      /Failed to push branch.*Permission to repo denied/,
    );
  });

  it('throws with a descriptive message when PR creation fails', async () => {
    const runGit = makeRunGit();
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') throw new Error('rate limit exceeded');
      return { stdout: '' };
    });

    await expect(publishSpecToPR(makeOpts(), runGit, runGh)).rejects.toThrow(
      /Failed to create PR.*rate limit exceeded/,
    );
  });

  it('throws when knowledge repo URL cannot be parsed', async () => {
    const runGit: RunGit = vi.fn().mockResolvedValue({ stdout: '' });
    const runGh = makeRunGh();

    const badProduct: Product = {
      ...makeProduct(),
      knowledge_repo: { url: 'https://gitlab.com/owner/repo', default_branch: 'main' },
    };

    await expect(
      publishSpecToPR({ ...makeOpts(), product: badProduct }, runGit, runGh),
    ).rejects.toThrow(/Cannot parse knowledge repo URL/);
  });

  it('uses a branch name derived from the externalId', async () => {
    const runGit = makeRunGit();
    const runGh = makeRunGh();

    await publishSpecToPR(makeOpts({ externalId: 'HLM-99' }), runGit, runGh);

    // mock.calls[i] = [args, opts]
    const gitCalls = (runGit as ReturnType<typeof vi.fn>).mock.calls as [string[], unknown][];
    const checkoutCall = gitCalls.find(([args]) => args[0] === 'checkout' && args[1] === '-B');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall![0][2]).toBe('helm/spec/HLM-99');
  });

  it('passes auth token via GIT_HTTP_EXTRAHEADER, not embedded in URL', async () => {
    const runGit = makeRunGit();
    const runGh = makeRunGh();

    await publishSpecToPR(makeOpts({ githubToken: 'secret-token' }), runGit, runGh);

    // mock.calls[i] = [args, opts] where opts has .env
    const gitCalls = (runGit as ReturnType<typeof vi.fn>).mock.calls as [
      string[],
      { cwd: string; env?: NodeJS.ProcessEnv },
    ][];
    const cloneCall = gitCalls.find(([args]) => args[0] === 'clone');
    const pushCall = gitCalls.find(([args]) => args[0] === 'push');

    // Token must NOT appear in any URL argument
    expect(cloneCall![0][1]).not.toContain('secret-token');
    expect(pushCall![0][1]).not.toContain('secret-token');

    // Token must appear as an Authorization header in the git env
    expect(cloneCall![1].env?.GIT_CONFIG_VALUE_0).toContain('secret-token');
  });

  it('throws on invalid externalId containing path traversal characters', async () => {
    const runGit: RunGit = vi.fn().mockResolvedValue({ stdout: '' });
    const runGh = makeRunGh();

    await expect(
      publishSpecToPR(makeOpts({ externalId: '../evil' }), runGit, runGh),
    ).rejects.toThrow(/Invalid externalId/);
  });

  it('throws with a helpful message when knowledge repo URL is SSH-format (git@)', async () => {
    const runGit: RunGit = vi.fn().mockResolvedValue({ stdout: '' });
    const runGh = makeRunGh();
    const sshProduct: Product = {
      ...makeProduct(),
      knowledge_repo: { url: 'git@github.com:test-org/knowledge.git', default_branch: 'main' },
    };

    await expect(publishSpecToPR(makeOpts({ product: sshProduct }), runGit, runGh)).rejects.toThrow(
      /SSH knowledge repo URLs are not supported.*Use an HTTPS URL/,
    );
  });

  it('throws with a helpful message when knowledge repo URL uses ssh:// scheme', async () => {
    const runGit: RunGit = vi.fn().mockResolvedValue({ stdout: '' });
    const runGh = makeRunGh();
    const sshProduct: Product = {
      ...makeProduct(),
      knowledge_repo: {
        url: 'ssh://git@github.com/test-org/knowledge.git',
        default_branch: 'main',
      },
    };

    await expect(publishSpecToPR(makeOpts({ product: sshProduct }), runGit, runGh)).rejects.toThrow(
      /SSH knowledge repo URLs are not supported.*Use an HTTPS URL/,
    );
  });

  it('cleans up the temp workdir even when push fails', async () => {
    // Capture the clone destination so we can verify it was removed afterwards.
    const capturedDirs: string[] = [];

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[2]!;
        capturedDirs.push(dest);
        await mkdir(join(dest, '.git'), { recursive: true });
        return { stdout: '' };
      }
      if (args[0] === 'push') throw new Error('remote: Permission to repo denied');
      return { stdout: '' };
    });
    const runGh = makeRunGh();

    await expect(publishSpecToPR(makeOpts(), runGit, runGh)).rejects.toThrow(/Failed to push/);

    // The temp workdir must be cleaned up even though publish failed.
    expect(capturedDirs).toHaveLength(1);
    await expect(stat(capturedDirs[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('two concurrent publishes for the same product use isolated workdirs and do not interfere', async () => {
    // Create a second spec file for the second concurrent publish.
    const specPath2 = join(tmpDir, 'workdir2', 'specs', 'issue_2.md');
    await mkdir(join(tmpDir, 'workdir2', 'specs'), { recursive: true });
    await writeFile(specPath2, '# issue_2 — Specification\n');

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[2]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });

    // Return a PR URL that embeds the branch name so we can verify each publish
    // got a distinct, correct URL.
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create') {
        const headIdx = args.indexOf('--head');
        const branch = headIdx >= 0 && args[headIdx + 1] ? args[headIdx + 1] : 'unknown';
        return { stdout: `https://github.com/test-org/knowledge/pull/${branch}\n` };
      }
      return { stdout: '' };
    });

    const [result1, result2] = await Promise.all([
      publishSpecToPR(makeOpts({ externalId: 'issue_1' }), runGit, runGh),
      publishSpecToPR(makeOpts({ externalId: 'issue_2', specPath: specPath2 }), runGit, runGh),
    ]);

    // Each publish must have produced a PR URL containing its own branch.
    expect(result1.prUrl).toContain('helm/spec/issue_1');
    expect(result2.prUrl).toContain('helm/spec/issue_2');
    // The two PRs must be distinct (no cross-contamination).
    expect(result1.prUrl).not.toBe(result2.prUrl);
  });
});
