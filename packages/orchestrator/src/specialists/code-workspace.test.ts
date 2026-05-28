import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  provisionCodeWorkspace,
  provisionReviewerWorkspace,
  openCodePR,
  pushReviewerPatches,
} from './code-workspace.js';
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

    // Token scrub: git remote set-url strips the authenticated URL from .git/config
    const setUrlArgs = capturedArgs.find((a) => a[0] === 'remote' && a[1] === 'set-url');
    expect(setUrlArgs).toBeDefined();
    expect(setUrlArgs).toContain('origin');
    // Plain URL (no token) — the agent cannot read the token from .git/config
    expect(setUrlArgs).toContain('https://github.com/test-org/test-repo');
    expect(setUrlArgs?.join(' ')).not.toContain('test-token');

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

// ── provisionReviewerWorkspace ────────────────────────────────────────────────

describe('provisionReviewerWorkspace', () => {
  let clonedPath: string | undefined;

  afterEach(async () => {
    if (clonedPath) {
      await rm(clonedPath, { recursive: true, force: true }).catch(() => {});
      clonedPath = undefined;
    }
  });

  it('clones impl branch directly (--depth 1 --branch helm/impl/{externalId})', async () => {
    const capturedArgs: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });

    const result = await provisionReviewerWorkspace(
      { externalId: 'HLM-42', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
      runGit,
    );

    clonedPath = result.workspacePath;

    // Clone uses --depth 1 --branch helm/impl/{externalId}
    const cloneArgs = capturedArgs.find((a) => a[0] === 'clone');
    expect(cloneArgs).toBeDefined();
    expect(cloneArgs).toContain('--depth');
    expect(cloneArgs).toContain('1');
    expect(cloneArgs).toContain('--branch');
    expect(cloneArgs).toContain('helm/impl/HLM-42');

    // No checkout -B — impl branch is already set by the clone
    const checkoutArgs = capturedArgs.find((a) => a[0] === 'checkout');
    expect(checkoutArgs).toBeUndefined();

    // Token scrub: remote set-url resets origin to canonical (no token)
    const setUrlArgs = capturedArgs.find((a) => a[0] === 'remote' && a[1] === 'set-url');
    expect(setUrlArgs).toBeDefined();
    expect(setUrlArgs).toContain('origin');
    expect(setUrlArgs).toContain('https://github.com/test-org/test-repo');
    expect(setUrlArgs?.join(' ')).not.toContain('test-token');

    // Returns the correct branch name
    expect(result.branchName).toBe('helm/impl/HLM-42');
  });

  it('uses helm-review- prefix to distinguish from implementer workspaces', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]!;
        await mkdir(join(dest, '.git'), { recursive: true });
      }
      return { stdout: '' };
    });

    const result = await provisionReviewerWorkspace(
      { externalId: 'HLM-42', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
      runGit,
    );

    clonedPath = result.workspacePath;
    expect(result.workspacePath).toContain('helm-review-');
    expect(result.workspacePath).not.toContain('helm-impl-');
  });

  it('rejects SSH code repo URLs', async () => {
    const runGit: RunGit = vi.fn();
    const sshRepo = makeCodeRepo('git@github.com:test-org/test-repo');

    await expect(
      provisionReviewerWorkspace(
        { externalId: 'HLM-42', codeRepo: sshRepo, githubToken: 'test-token' },
        runGit,
      ),
    ).rejects.toThrow('SSH code repo URLs are not supported');

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects dot-prefixed externalIds', async () => {
    const runGit: RunGit = vi.fn();

    await expect(
      provisionReviewerWorkspace(
        { externalId: '.hidden', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
        runGit,
      ),
    ).rejects.toThrow('Invalid externalId');

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects externalIds with slashes', async () => {
    const runGit: RunGit = vi.fn();

    await expect(
      provisionReviewerWorkspace(
        { externalId: 'foo/bar', codeRepo: makeCodeRepo(), githubToken: 'test-token' },
        runGit,
      ),
    ).rejects.toThrow('Invalid externalId');
  });

  it('sanitizes token from clone error messages (e.g. impl branch not found)', async () => {
    const runGit: RunGit = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'fatal: Remote branch helm/impl/HLM-42 not found in upstream x-access-token:tok-secret@github.com',
        ),
      );

    await expect(
      provisionReviewerWorkspace(
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
    // push force — uses authenticated URL directly (not origin, which is plain after provisioning)
    const pushArgs = capturedGitArgs.find((a) => a[0] === 'push');
    expect(pushArgs).toContain('--force');
    expect(pushArgs).toContain('helm/impl/HLM-42:helm/impl/HLM-42');
    const pushUrl = pushArgs?.find((a) => a.includes('x-access-token:'));
    expect(pushUrl).toBeDefined();
    expect(pushUrl).toContain('test-token');

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

  it('sanitizes token from git error messages (openCodePR)', async () => {
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

// ── pushReviewerPatches ───────────────────────────────────────────────────────

describe('pushReviewerPatches', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `test-review-ws-${randomUUID()}`);
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
  });

  it('returns { pushed: false } when workspace is clean (no changes)', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: '' }; // clean
      return { stdout: '' };
    });

    const result = await pushReviewerPatches(makeBaseOpts(), runGit);

    expect(result).toEqual({ pushed: false });
    // Only status was called — no add/commit/push
    // mock.calls is [[args, opts], ...] so calls[i][0] is the args array
    const calls = (runGit as ReturnType<typeof vi.fn>).mock.calls as [string[], unknown][];
    const nonStatusCalls = calls.filter(([args]) => args[0] !== 'status');
    expect(nonStatusCalls).toHaveLength(0);
  });

  it('stages, commits, and pushes when workspace has changes; returns pushed+SHA', async () => {
    const capturedArgs: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' }; // dirty
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      return { stdout: '' };
    });

    const result = await pushReviewerPatches(makeBaseOpts(), runGit);

    expect(result).toEqual({ pushed: true, commitSha: 'abc123' });

    // add -A called
    const addArgs = capturedArgs.find((a) => a[0] === 'add');
    expect(addArgs).toContain('-A');

    // commit with correct message
    const commitArgs = capturedArgs.find((a) => a[0] === 'commit');
    expect(commitArgs).toBeDefined();
    expect(commitArgs!.join(' ')).toContain('apply code-reviewer patches for HLM-42');

    // push with refspec and NO --force
    const pushArgs = capturedArgs.find((a) => a[0] === 'push');
    expect(pushArgs).toBeDefined();
    expect(pushArgs!.join(' ')).toContain('helm/impl/HLM-42:helm/impl/HLM-42');
    expect(pushArgs).not.toContain('--force');
  });

  it('push uses authenticated URL (x-access-token) and NOT --force', async () => {
    const capturedArgs: string[][] = [];
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' };
      if (args[0] === 'rev-parse') return { stdout: 'deadbeef\n' };
      return { stdout: '' };
    });

    await pushReviewerPatches(makeBaseOpts(), runGit);

    const pushArgs = capturedArgs.find((a) => a[0] === 'push');
    expect(pushArgs).toBeDefined();
    const pushUrl = pushArgs!.find((a) => a.includes('x-access-token:'));
    expect(pushUrl).toBeDefined();
    expect(pushUrl).toContain('test-token');
    expect(pushUrl).toContain('test-org/test-repo');
    expect(pushArgs).not.toContain('--force');
  });

  it('sanitizes token from push error messages', async () => {
    const sensitiveToken = 'ghp_reviewer_secret_9x7y';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' };
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      if (args[0] === 'push')
        throw new Error(`fatal: push rejected, x-access-token:${sensitiveToken}@github.com`);
      return { stdout: '' };
    });

    let thrownError: Error | undefined;
    try {
      await pushReviewerPatches({ ...makeBaseOpts(), githubToken: sensitiveToken }, runGit);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(sensitiveToken);
    expect(thrownError!.message).toContain('***');
  });

  it('rejects dot-prefixed externalIds immediately (no git calls)', async () => {
    const runGit: RunGit = vi.fn();

    await expect(
      pushReviewerPatches({ ...makeBaseOpts(), externalId: '.hidden' }, runGit),
    ).rejects.toThrow('Invalid externalId');

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects externalIds with slashes immediately (no git calls)', async () => {
    const runGit: RunGit = vi.fn();

    await expect(
      pushReviewerPatches({ ...makeBaseOpts(), externalId: 'foo/bar' }, runGit),
    ).rejects.toThrow('Invalid externalId');

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects unparseable codeRepo.url with a clear error message', async () => {
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' };
      return { stdout: '' };
    });

    await expect(
      pushReviewerPatches({ ...makeBaseOpts(), codeRepo: makeCodeRepo('not-a-valid-url') }, runGit),
    ).rejects.toThrow('[code-workspace]');
  });

  it('sanitizes token from git status error messages', async () => {
    const sensitiveToken = 'ghp_status_secret';
    const runGit: RunGit = vi
      .fn()
      .mockRejectedValue(
        new Error(`fatal: not a git repository x-access-token:${sensitiveToken}@github.com`),
      );

    let thrownError: Error | undefined;
    try {
      await pushReviewerPatches({ ...makeBaseOpts(), githubToken: sensitiveToken }, runGit);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(sensitiveToken);
    expect(thrownError!.message).toContain('[code-workspace]');
  });

  it('sanitizes token from git add error messages', async () => {
    const sensitiveToken = 'ghp_add_secret';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' };
      throw new Error(`fatal: add failed x-access-token:${sensitiveToken}@github.com`);
    });

    let thrownError: Error | undefined;
    try {
      await pushReviewerPatches({ ...makeBaseOpts(), githubToken: sensitiveToken }, runGit);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(sensitiveToken);
    expect(thrownError!.message).toContain('[code-workspace]');
  });

  it('sanitizes token from git commit error messages', async () => {
    const sensitiveToken = 'ghp_commit_secret';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' };
      if (args[0] === 'add') return { stdout: '' };
      throw new Error(`fatal: commit failed x-access-token:${sensitiveToken}@github.com`);
    });

    let thrownError: Error | undefined;
    try {
      await pushReviewerPatches({ ...makeBaseOpts(), githubToken: sensitiveToken }, runGit);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(sensitiveToken);
    expect(thrownError!.message).toContain('[code-workspace]');
  });

  it('sanitizes token from git rev-parse error messages', async () => {
    const sensitiveToken = 'ghp_revparse_secret';
    const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: 'M  src/fix.ts\n' };
      if (args[0] === 'add') return { stdout: '' };
      if (args[0] === 'commit') return { stdout: '' };
      throw new Error(`fatal: rev-parse error x-access-token:${sensitiveToken}@github.com`);
    });

    let thrownError: Error | undefined;
    try {
      await pushReviewerPatches({ ...makeBaseOpts(), githubToken: sensitiveToken }, runGit);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(sensitiveToken);
    expect(thrownError!.message).toContain('[code-workspace]');
  });
});
