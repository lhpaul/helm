import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { provisionCodeWorkspace, openCodePR } from './code-workspace.js';
import type { RunGit, RunGh } from './git-helpers.js';
import type { CodeRepo } from '@helm/shared';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeCodeRepo = (url = 'https://github.com/test-org/test-repo'): CodeRepo => ({
  url,
  default_branch: 'main',
  role: 'app',
});

// ── provisionCodeWorkspace ────────────────────────────────────────────────────

describe('provisionCodeWorkspace', () => {
  let clonedPath: string | undefined;

  afterEach(async () => {
    if (clonedPath) {
      await rm(clonedPath, { recursive: true, force: true }).catch(() => {});
      clonedPath = undefined;
    }
  });

  it('performs shallow clone and creates impl branch', async () => {
    const capturedArgs: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'clone') {
        // Simulate clone by creating a minimal .git directory
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });

    const result = await provisionCodeWorkspace(
      { externalId: 'HLM-42', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
      runGit,
    );

    clonedPath = result.workspacePath;

    // Clone call uses --depth 1
    const cloneArgs = capturedArgs.find((a) => a[0] === 'clone');
    expect(cloneArgs).toBeDefined();
    expect(cloneArgs).toContain('--depth');
    expect(cloneArgs).toContain('1');

    // Clone URL must not appear in args in plain form (token embedded)
    const cloneUrl = cloneArgs?.find((a) => a.includes('x-access-token:'));
    expect(cloneUrl).toBeDefined();
    expect(cloneUrl).toContain('test-token');
    expect(cloneUrl).toContain('test-org/test-repo');

    // Checkout call creates the impl branch
    const checkoutArgs = capturedArgs.find((a) => a[0] === 'checkout');
    expect(checkoutArgs).toBeDefined();
    expect(checkoutArgs).toContain('-B');
    expect(checkoutArgs).toContain('helm/impl/HLM-42');

    // Result has the correct branch name
    expect(result.branchName).toBe('helm/impl/HLM-42');
  });

  it('rejects SSH code repo URLs', async () => {
    const runGit: RunGit = vi.fn();
    const sshRepo = makeCodeRepo('git@github.com:test-org/test-repo');

    await expect(
      provisionCodeWorkspace(
        { externalId: 'HLM-42', codeRepo: sshRepo, githubToken: 'test-token' },
        runGit,
      ),
    ).rejects.toThrow('SSH code repo URLs are not supported');

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects dot-prefixed externalIds', async () => {
    const runGit: RunGit = vi.fn();

    await expect(
      provisionCodeWorkspace(
        { externalId: '.hidden', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
        runGit,
      ),
    ).rejects.toThrow('Invalid externalId');

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects externalIds with slashes', async () => {
    const runGit: RunGit = vi.fn();

    await expect(
      provisionCodeWorkspace(
        { externalId: 'foo/bar', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
        runGit,
      ),
    ).rejects.toThrow('Invalid externalId');
  });

  it('sanitizes token from clone error messages', async () => {
    const runGit: RunGit = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'fatal: could not read from remote repository x-access-token:tok-secret@github.com',
        ),
      );

    await expect(
      provisionCodeWorkspace(
        { externalId: 'HLM-42', codeRepo: makeCodeRepo(), githubToken: 'tok-secret' },
        runGit,
      ),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('tok-secret') }),
    );
  });
});

// ── openCodePR ────────────────────────────────────────────────────────────────

describe('openCodePR', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `test-ws-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  });

  const makeBaseOpts = () => ({
    externalId: 'HLM-42',
    codeRepo: makeCodeRepo(),
    workspacePath,
    githubToken: 'test-token',
    prTitle: 'feat: implement HLM-42',
    prBody: 'Implementation for HLM-42',
  });

  it('returns prUrl empty string when git status is clean (no changes)', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: '' }; // clean
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn();

    const result = await openCodePR(makeBaseOpts(), runGit, runGh);

    expect(result.prUrl).toBe('');
    expect(runGh).not.toHaveBeenCalled();
  });

  it('stages, commits, pushes, and creates PR when there are changes', async () => {
    const capturedGitArgs: string[][] = [];
    const capturedGhArgs: string[][] = [];

    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      capturedGitArgs.push([...args]);
      if (args[0] === 'status') return { stdout: 'M  src/file.ts\n' }; // dirty
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      capturedGhArgs.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
      if (args[0] === 'pr' && args[1] === 'create')
        return { stdout: 'https://github.com/test-org/test-repo/pull/1\n' };
      return { stdout: '' };
    });

    const result = await openCodePR(makeBaseOpts(), runGit, runGh);

    // Check all expected git calls occurred in order
    expect(capturedGitArgs.map((a) => a[0])).toEqual(
      expect.arrayContaining(['status', 'add', 'commit', 'push']),
    );
    // add -A
    const addArgs = capturedGitArgs.find((a) => a[0] === 'add');
    expect(addArgs).toContain('-A');
    // push force
    const pushArgs = capturedGitArgs.find((a) => a[0] === 'push');
    expect(pushArgs).toContain('--force');
    expect(pushArgs).toContain('helm/impl/HLM-42:helm/impl/HLM-42');

    expect(result.prUrl).toBe('https://github.com/test-org/test-repo/pull/1');
  });

  it('returns existing PR URL when an open PR already exists (idempotent)', async () => {
    const existingUrl = 'https://github.com/test-org/test-repo/pull/5';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/file.ts\n' };
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list')
        return { stdout: JSON.stringify([{ url: existingUrl }]) };
      return { stdout: '' };
    });

    const createSpy = vi.fn();
    const wrappedGh: RunGh = vi.fn().mockImplementation(async (args, opts) => {
      if (args[0] === 'pr' && args[1] === 'create') createSpy();
      return runGh(args, opts);
    });

    const result = await openCodePR(makeBaseOpts(), runGit, wrappedGh);

    expect(result.prUrl).toBe(existingUrl);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects dot-prefixed externalIds', async () => {
    const runGit: RunGit = vi.fn();
    const runGh: RunGh = vi.fn();

    await expect(
      openCodePR({ ...makeBaseOpts(), externalId: '.hidden' }, runGit, runGh),
    ).rejects.toThrow('Invalid externalId');
  });

  it('sanitizes token from git error messages', async () => {
    const sensitiveToken = 'ghp_super_secret_9x7y';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  file.ts\n' };
      if (args[0] === 'push')
        throw new Error(`fatal: push rejected, x-access-token:${sensitiveToken}@github.com`);
      return { stdout: '' };
    });
    const runGh: RunGh = vi.fn();

    let thrownError: Error | undefined;
    try {
      await openCodePR({ ...makeBaseOpts(), githubToken: sensitiveToken }, runGit, runGh);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(sensitiveToken);
    expect(thrownError!.message).toContain('***');
  });
});
