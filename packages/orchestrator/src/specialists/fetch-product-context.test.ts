import { describe, expect, it, vi } from 'vitest';
import { fetchProductContext, parseGitHubRepoUrl } from './fetch-product-context.js';
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

  it('falls back to CLAUDE.md when AGENT.md is absent', async () => {
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
    expect(calls[0][1].headers.Authorization).toBe('Bearer my-token');
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
