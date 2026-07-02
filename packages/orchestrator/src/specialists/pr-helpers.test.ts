import { describe, expect, it, vi } from 'vitest';
import { findCodePRUrl, postPRComment, upsertPRCommentByMarker } from './pr-helpers.js';
import type { RunGh } from './git-helpers.js';
import type { CodeRepo } from '@helm/shared';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeCodeRepo = (url = 'https://github.com/test-org/test-repo'): CodeRepo => ({
  url,
  default_branch: 'main',
  role: 'app',
});

const PR_URL = 'https://github.com/test-org/test-repo/pull/1';

// ── findCodePRUrl ─────────────────────────────────────────────────────────────

describe('findCodePRUrl', () => {
  it('returns the PR URL when an open PR exists for the impl branch', async () => {
    const runGh: RunGh = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ url: PR_URL }]) });

    const result = await findCodePRUrl(
      { codeRepo: makeCodeRepo(), externalId: 'HLM-42', githubToken: 'test-token' },
      runGh,
    );

    expect(result).toBe(PR_URL);
  });

  it('returns null when no open PRs exist for the impl branch', async () => {
    const runGh: RunGh = vi.fn().mockResolvedValue({ stdout: '[]' });

    const result = await findCodePRUrl(
      { codeRepo: makeCodeRepo(), externalId: 'HLM-42', githubToken: 'test-token' },
      runGh,
    );

    expect(result).toBeNull();
  });

  it('propagates errors from gh CLI', async () => {
    const runGh: RunGh = vi.fn().mockRejectedValue(new Error('gh: not authenticated'));

    await expect(
      findCodePRUrl(
        { codeRepo: makeCodeRepo(), externalId: 'HLM-42', githubToken: 'test-token' },
        runGh,
      ),
    ).rejects.toThrow('gh: not authenticated');
  });

  it('queries for the correct helm/impl/{externalId} branch name', async () => {
    const capturedArgs: string[][] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      return { stdout: '[]' };
    });

    await findCodePRUrl(
      { codeRepo: makeCodeRepo(), externalId: 'HLM-99', githubToken: 'test-token' },
      runGh,
    );

    expect(runGh).toHaveBeenCalledOnce();
    const args = capturedArgs[0]!;
    expect(args).toContain('--head');
    const headIdx = args.indexOf('--head');
    expect(args[headIdx + 1]).toBe('helm/impl/HLM-99');
  });

  it('passes GITHUB_TOKEN in env when calling gh pr list', async () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (_args, opts) => {
      if (opts.env) capturedEnvs.push(opts.env);
      return { stdout: '[]' };
    });

    await findCodePRUrl(
      { codeRepo: makeCodeRepo(), externalId: 'HLM-42', githubToken: 'secret-token' },
      runGh,
    );

    expect(capturedEnvs[0]).toBeDefined();
    expect(capturedEnvs[0]!['GITHUB_TOKEN']).toBe('secret-token');
  });

  it('calls gh pr list with --repo {owner}/{repo} and --state open', async () => {
    const capturedArgs: string[][] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      return { stdout: '[]' };
    });

    await findCodePRUrl(
      { codeRepo: makeCodeRepo(), externalId: 'HLM-42', githubToken: 'test-token' },
      runGh,
    );

    const args = capturedArgs[0]!;
    expect(args).toContain('--repo');
    const repoIdx = args.indexOf('--repo');
    expect(args[repoIdx + 1]).toBe('test-org/test-repo');
    expect(args).toContain('--state');
    const stateIdx = args.indexOf('--state');
    expect(args[stateIdx + 1]).toBe('open');
  });

  it('throws when the code repo URL cannot be parsed', async () => {
    const runGh: RunGh = vi.fn();
    const badRepo = makeCodeRepo('not-a-url');

    await expect(
      findCodePRUrl({ codeRepo: badRepo, externalId: 'HLM-42', githubToken: 'test-token' }, runGh),
    ).rejects.toThrow('Cannot parse code repo URL');

    expect(runGh).not.toHaveBeenCalled();
  });
});

// ── postPRComment ─────────────────────────────────────────────────────────────

describe('postPRComment', () => {
  it('parses URL and calls gh pr comment with the correct args', async () => {
    const capturedArgs: string[][] = [];
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args, opts) => {
      capturedArgs.push([...args]);
      if (opts.env) capturedEnvs.push(opts.env);
      return { stdout: '' };
    });

    await postPRComment(
      {
        prUrl: 'https://github.com/test-org/test-repo/pull/42',
        body: 'Great implementation!',
        githubToken: 'test-token',
      },
      runGh,
    );

    expect(runGh).toHaveBeenCalledOnce();
    const args = capturedArgs[0]!;
    expect(args[0]).toBe('pr');
    expect(args[1]).toBe('comment');
    expect(args[2]).toBe('42');
    expect(args).toContain('--repo');
    const repoIdx = args.indexOf('--repo');
    expect(args[repoIdx + 1]).toBe('test-org/test-repo');
    expect(args).toContain('--body');
    const bodyIdx = args.indexOf('--body');
    expect(args[bodyIdx + 1]).toBe('Great implementation!');

    // GITHUB_TOKEN must be in the env
    expect(capturedEnvs[0]!['GITHUB_TOKEN']).toBe('test-token');
  });

  it('throws when the PR URL cannot be parsed', async () => {
    const runGh: RunGh = vi.fn();

    await expect(
      postPRComment(
        { prUrl: 'https://not-a-pr-url.com/foo', body: 'review', githubToken: 'test-token' },
        runGh,
      ),
    ).rejects.toThrow('Cannot parse PR URL');

    expect(runGh).not.toHaveBeenCalled();
  });

  it('propagates errors from gh CLI', async () => {
    const runGh: RunGh = vi.fn().mockRejectedValue(new Error('gh: rate limited'));

    await expect(
      postPRComment(
        {
          prUrl: 'https://github.com/test-org/test-repo/pull/5',
          body: 'review',
          githubToken: 'test-token',
        },
        runGh,
      ),
    ).rejects.toThrow('gh: rate limited');
  });
});

describe('upsertPRCommentByMarker', () => {
  it('patches an existing comment when the marker is present', async () => {
    const capturedArgs: string[][] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'api' && args[1]?.endsWith('/comments') && args[2] === '--paginate') {
        return {
          stdout: JSON.stringify([
            { id: 99, body: '<!-- helm:review-loop-summary --> old', created_at: '2026-01-01' },
          ]),
        };
      }
      return { stdout: '' };
    });

    await upsertPRCommentByMarker(
      {
        prUrl: 'https://github.com/test-org/test-repo/pull/42',
        body: '<!-- helm:review-loop-summary -->\nnew body',
        githubToken: 'test-token',
        marker: '<!-- helm:review-loop-summary -->',
      },
      runGh,
    );

    const patchCall = capturedArgs.find((args) => args.includes('PATCH'));
    expect(patchCall).toBeDefined();
    expect(patchCall!.join(' ')).toContain('issues/comments/99');
    expect(runGh).not.toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'comment']),
      expect.anything(),
    );
  });

  it('creates a new comment when no marker comment exists', async () => {
    const capturedArgs: string[][] = [];
    const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
      capturedArgs.push([...args]);
      if (args[0] === 'api') return { stdout: '[]' };
      return { stdout: '' };
    });

    await upsertPRCommentByMarker(
      {
        prUrl: 'https://github.com/test-org/test-repo/pull/42',
        body: '<!-- helm:review-loop-summary -->\nnew body',
        githubToken: 'test-token',
        marker: '<!-- helm:review-loop-summary -->',
      },
      runGh,
    );

    expect(capturedArgs.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(true);
  });
});
