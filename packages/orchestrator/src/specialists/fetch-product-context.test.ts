import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProductContext,
  fetchSpecForPlan,
  materializeProductContext,
  parseGitHubRepoUrl,
} from './fetch-product-context.js';
import type { FetchFn } from './fetch-product-context.js';
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
    readiness_gate: 'skip',
    final_stage: 'released',
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

/** Returns a minimal mock Response-like object. */
const okResponse = (body: string) => ({ ok: true, text: () => Promise.resolve(body) }) as Response;
const notFound = () =>
  ({ ok: false, status: 404, text: () => Promise.resolve('Not Found') }) as Response;

// ── parseGitHubRepoUrl ────────────────────────────────────────────────────────

describe('parseGitHubRepoUrl', () => {
  it('parses standard HTTPS URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('strips .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('handles trailing slash', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepoUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHubRepoUrl('not-a-url')).toBeNull();
  });

  it('parses SSH-style URL (git@github.com:owner/repo.git)', () => {
    expect(parseGitHubRepoUrl('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses SSH-style URL without .git suffix', () => {
    expect(parseGitHubRepoUrl('git@github.com:owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for SSH URLs pointing to non-GitHub hosts', () => {
    expect(parseGitHubRepoUrl('git@gitlab.com:owner/repo.git')).toBeNull();
  });

  it('parses SSH-style URL with dots in repo name (e.g. my.repo.git)', () => {
    expect(parseGitHubRepoUrl('git@github.com:owner/my.repo.git')).toEqual({
      owner: 'owner',
      repo: 'my.repo',
    });
  });

  it('parses HTTPS URL with dots in repo name', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/my.repo')).toEqual({
      owner: 'owner',
      repo: 'my.repo',
    });
  });

  it('parses SSH-style URL with dots in repo name and no .git suffix', () => {
    expect(parseGitHubRepoUrl('git@github.com:owner/my.repo')).toEqual({
      owner: 'owner',
      repo: 'my.repo',
    });
  });
});

// ── fetchProductContext ───────────────────────────────────────────────────────

describe('fetchProductContext', () => {
  it('returns readme and agentMd when both files exist', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('README.md')) return Promise.resolve(okResponse('# My README'));
      if ((url as string).includes('AGENT.md'))
        return Promise.resolve(okResponse('# Agent instructions'));
      return Promise.resolve(notFound());
    });

    const ctx = await fetchProductContext(makeProduct(), 'tok', mockFetch);

    expect(ctx.readme).toBe('# My README');
    expect(ctx.agentMd).toBe('# Agent instructions');
  });

  it('prefers AGENTS.md over AGENT.md and CLAUDE.md', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('README.md')) return Promise.resolve(okResponse('readme'));
      if ((url as string).includes('AGENTS.md')) return Promise.resolve(okResponse('agents md'));
      if ((url as string).includes('AGENT.md')) return Promise.resolve(okResponse('agent md'));
      if ((url as string).includes('CLAUDE.md')) return Promise.resolve(okResponse('claude md'));
      return Promise.resolve(notFound());
    });

    const ctx = await fetchProductContext(makeProduct(), 'tok', mockFetch);

    expect(ctx.agentMd).toBe('agents md');
  });

  it('falls back to AGENT.md when AGENTS.md is absent', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('README.md')) return Promise.resolve(okResponse('readme'));
      if ((url as string).includes('AGENTS.md')) return Promise.resolve(notFound());
      if ((url as string).includes('AGENT.md')) return Promise.resolve(okResponse('agent md'));
      return Promise.resolve(notFound());
    });

    const ctx = await fetchProductContext(makeProduct(), 'tok', mockFetch);

    expect(ctx.agentMd).toBe('agent md');
  });

  it('falls back to CLAUDE.md when AGENTS.md and AGENT.md are absent', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('README.md')) return Promise.resolve(okResponse('readme'));
      if ((url as string).includes('AGENT.md')) return Promise.resolve(notFound());
      if ((url as string).includes('CLAUDE.md')) return Promise.resolve(okResponse('claude md'));
      return Promise.resolve(notFound());
    });

    const ctx = await fetchProductContext(makeProduct(), 'tok', mockFetch);

    expect(ctx.readme).toBe('readme');
    expect(ctx.agentMd).toBe('claude md');
  });

  it('returns undefined fields when files are absent (404)', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    const ctx = await fetchProductContext(makeProduct(), 'tok', mockFetch);

    expect(ctx.readme).toBeUndefined();
    expect(ctx.agentMd).toBeUndefined();
  });

  it('truncates README longer than 2000 chars', async () => {
    const longReadme = 'x'.repeat(3000);
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes('README.md')) return Promise.resolve(okResponse(longReadme));
      return Promise.resolve(notFound());
    });

    const ctx = await fetchProductContext(makeProduct(), 'tok', mockFetch);

    expect(ctx.readme).toBeDefined();
    expect(ctx.readme!.length).toBeLessThan(longReadme.length);
    expect(ctx.readme!).toContain('[...truncated]');
  });

  it('passes Authorization header with token', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    await fetchProductContext(makeProduct(), 'my-token', mockFetch);

    const calls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { headers: Record<string, string> },
    ][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![1].headers.Authorization).toBe('Bearer my-token');
  });

  it('returns empty context when product has no code repos', async () => {
    const mockFetch: FetchFn = vi.fn();
    const product = { ...makeProduct(), code_repos: [] } as unknown as Product;

    const ctx = await fetchProductContext(product, 'tok', mockFetch);

    expect(ctx.readme).toBeUndefined();
    expect(ctx.agentMd).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches from the correct raw.githubusercontent.com URL', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    await fetchProductContext(makeProduct(), 'tok', mockFetch);

    const urls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(
      urls.some((u) => u.startsWith('https://raw.githubusercontent.com/test-org/test-repo/main/')),
    ).toBe(true);
  });
});

// ── materializeProductContext ─────────────────────────────────────────────────

describe('materializeProductContext', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'helm-materialize-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes README + CLAUDE.md verbatim (no truncation) and returns their paths', async () => {
    // README deliberately exceeds the 2000-char prompt cap to prove the on-disk
    // copy is the full file, not the truncated prompt snippet.
    const longReadme = '# README\n' + 'x'.repeat(3000);
    const claude = '# CLAUDE.md\n\n## Section 4\nrepo-specific notes';
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('README.md')) return Promise.resolve(okResponse(longReadme));
      if (url.includes('AGENTS.md')) return Promise.resolve(notFound());
      if (url.includes('AGENT.md')) return Promise.resolve(notFound());
      if (url.includes('CLAUDE.md')) return Promise.resolve(okResponse(claude));
      return Promise.resolve(notFound());
    });

    const result = await materializeProductContext(workdir, makeProduct(), 'tok', mockFetch);

    // Both files on disk, contents verbatim.
    expect(await readFile(join(workdir, 'README.md'), 'utf8')).toBe(longReadme);
    expect(await readFile(join(workdir, 'CLAUDE.md'), 'utf8')).toBe(claude);

    // Return shape points at the written files; no truncation suffix.
    expect(result.readme).toEqual({
      path: join(workdir, 'README.md'),
      bytes: Buffer.byteLength(longReadme, 'utf8'),
    });
    expect(result.readme!.bytes).toBeGreaterThan(2000);
    expect(result.agentInstructions).toEqual({
      path: join(workdir, 'CLAUDE.md'),
      filename: 'CLAUDE.md',
      bytes: Buffer.byteLength(claude, 'utf8'),
    });
    expect(result.missingFiles).toEqual([]);
  });

  it('preserves the AGENT.md variant name when only AGENT.md exists (no rename)', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('README.md')) return Promise.resolve(okResponse('readme'));
      if (url.includes('AGENTS.md')) return Promise.resolve(notFound());
      if (url.includes('AGENT.md')) return Promise.resolve(okResponse('# Agent instructions'));
      return Promise.resolve(notFound());
    });

    const result = await materializeProductContext(workdir, makeProduct(), 'tok', mockFetch);

    expect(await readFile(join(workdir, 'AGENT.md'), 'utf8')).toBe('# Agent instructions');
    expect(result.agentInstructions!.filename).toBe('AGENT.md');
    // No CLAUDE.md / AGENTS.md written.
    const entries = await readdir(workdir);
    expect(entries.sort()).toEqual(['AGENT.md', 'README.md']);
  });

  it('materializes only AGENTS.md when both AGENTS.md and CLAUDE.md exist', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('README.md')) return Promise.resolve(okResponse('readme'));
      if (url.includes('AGENTS.md')) return Promise.resolve(okResponse('# AGENTS open standard'));
      if (url.includes('CLAUDE.md')) return Promise.resolve(okResponse('# CLAUDE'));
      return Promise.resolve(notFound());
    });

    const result = await materializeProductContext(workdir, makeProduct(), 'tok', mockFetch);

    expect(result.agentInstructions!.filename).toBe('AGENTS.md');
    const entries = await readdir(workdir);
    expect(entries).toContain('AGENTS.md');
    expect(entries).not.toContain('CLAUDE.md');
  });

  it('still writes the agent instruction file when README is absent', async () => {
    const mockFetch: FetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('README.md')) return Promise.resolve(notFound());
      if (url.includes('AGENTS.md')) return Promise.resolve(okResponse('# AGENTS'));
      return Promise.resolve(notFound());
    });

    const result = await materializeProductContext(workdir, makeProduct(), 'tok', mockFetch);

    expect(result.readme).toBeNull();
    expect(result.missingFiles).toContain('README.md');
    expect(result.agentInstructions!.filename).toBe('AGENTS.md');
    const entries = await readdir(workdir);
    expect(entries).toEqual(['AGENTS.md']);
  });

  it('returns gracefully and writes nothing when both files are absent', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    const result = await materializeProductContext(workdir, makeProduct(), 'tok', mockFetch);

    expect(result.readme).toBeNull();
    expect(result.agentInstructions).toBeNull();
    expect(result.missingFiles).toEqual(['README.md', 'AGENTS.md', 'AGENT.md', 'CLAUDE.md']);
    expect(await readdir(workdir)).toEqual([]);
  });

  it('propagates a non-404 HTTP error (does not swallow it)', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as Response);

    await expect(
      materializeProductContext(workdir, makeProduct(), 'tok', mockFetch),
    ).rejects.toThrow(/403/);
  });

  it('returns all-missing without fetching when the product has no code repos', async () => {
    const mockFetch: FetchFn = vi.fn();
    const product = { ...makeProduct(), code_repos: [] } as unknown as Product;

    const result = await materializeProductContext(workdir, product, 'tok', mockFetch);

    expect(result.readme).toBeNull();
    expect(result.agentInstructions).toBeNull();
    expect(result.missingFiles).toEqual(['README.md', 'AGENTS.md', 'AGENT.md', 'CLAUDE.md']);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await readdir(workdir)).toEqual([]);
  });

  it('passes the Authorization header with the token', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    await materializeProductContext(workdir, makeProduct(), 'my-token', mockFetch);

    const calls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { headers: Record<string, string> },
    ][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![1].headers.Authorization).toBe('Bearer my-token');
  });
});

// ── fetchSpecForPlan ──────────────────────────────────────────────────────────

describe('fetchSpecForPlan', () => {
  it('returns spec content when file exists', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(okResponse('# My Spec\n\n## Context'));

    const content = await fetchSpecForPlan(makeProduct(), 'issue_1', 'tok', mockFetch);

    expect(content).toBe('# My Spec\n\n## Context');
  });

  it('returns null when spec file is not found (404)', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    const content = await fetchSpecForPlan(makeProduct(), 'issue_1', 'tok', mockFetch);

    expect(content).toBeNull();
  });

  it('fetches from the knowledge repo at specs/{externalId}.md on the default branch', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    await fetchSpecForPlan(makeProduct(), 'issue_42', 'tok', mockFetch);

    const urls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      'https://raw.githubusercontent.com/test-org/knowledge/main/specs/issue_42.md',
    );
  });

  it('passes Authorization header with token', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(notFound());

    await fetchSpecForPlan(makeProduct(), 'issue_1', 'my-token', mockFetch);

    const calls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { headers: Record<string, string> },
    ][];
    expect(calls[0]![1].headers.Authorization).toBe('Bearer my-token');
  });

  it('returns null when knowledge_repo URL cannot be parsed', async () => {
    const mockFetch: FetchFn = vi.fn();
    const product: Product = {
      ...makeProduct(),
      knowledge_repo: { url: 'not-a-valid-url', default_branch: 'main' },
    };

    const content = await fetchSpecForPlan(product, 'issue_1', 'tok', mockFetch);

    expect(content).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('truncates spec content exceeding 32000 chars with a generous suffix', async () => {
    const longSpec = 'x'.repeat(35_000);
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(okResponse(longSpec));

    const content = await fetchSpecForPlan(makeProduct(), 'issue_1', 'tok', mockFetch);

    expect(content).toBeDefined();
    expect(content!.length).toBeLessThan(longSpec.length);
    expect(content!).toContain('[...truncated');
  });

  it('does not truncate spec content within the 32000-char limit', async () => {
    const normalSpec = 'x'.repeat(1000);
    const mockFetch: FetchFn = vi.fn().mockResolvedValue(okResponse(normalSpec));

    const content = await fetchSpecForPlan(makeProduct(), 'issue_1', 'tok', mockFetch);

    expect(content).toBe(normalSpec);
  });

  it('throws when spec fetch returns a non-404 error (e.g. 403)', async () => {
    const mockFetch: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as Response);

    await expect(fetchSpecForPlan(makeProduct(), 'issue_1', 'tok', mockFetch)).rejects.toThrow(
      /403/,
    );
  });

  it('throws on invalid externalId (path traversal)', async () => {
    const mockFetch: FetchFn = vi.fn();
    await expect(fetchSpecForPlan(makeProduct(), '../evil', 'tok', mockFetch)).rejects.toThrow(
      /Invalid externalId/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
