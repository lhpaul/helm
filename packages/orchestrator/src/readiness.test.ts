import { describe, expect, it, vi } from 'vitest';
import { checkProductReadiness } from './readiness.js';
import type { FetchFn } from './specialists/fetch-product-context.js';
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
    readiness_gate: 'required',
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

const okResponse = (body: string) => ({ ok: true, text: () => Promise.resolve(body) }) as Response;
const notFound = () =>
  ({ ok: false, status: 404, text: () => Promise.resolve('Not Found') }) as Response;

/** A fetch mock keyed on which filenames "exist" (200) — everything else 404s. */
const fetchWithFiles = (present: string[]): FetchFn =>
  vi.fn().mockImplementation((url: string) => {
    const hit = present.some((f) => (url as string).includes(`/${f}`));
    return Promise.resolve(hit ? okResponse(`content of ${url}`) : notFound());
  });

// ── checkProductReadiness ───────────────────────────────────────────────────────

describe('checkProductReadiness', () => {
  it('is ready when README and AGENTS.md are present', async () => {
    const result = await checkProductReadiness(
      makeProduct(),
      'tok',
      fetchWithFiles(['README.md', 'AGENTS.md']),
    );
    expect(result.ready).toBe(true);
    expect(result.missingContext).toEqual([]);
  });

  it('accepts AGENT.md or CLAUDE.md as agent instructions', async () => {
    const withAgent = await checkProductReadiness(
      makeProduct(),
      'tok',
      fetchWithFiles(['README.md', 'AGENT.md']),
    );
    expect(withAgent.ready).toBe(true);

    const withClaude = await checkProductReadiness(
      makeProduct(),
      'tok',
      fetchWithFiles(['README.md', 'CLAUDE.md']),
    );
    expect(withClaude.ready).toBe(true);
  });

  it('reports README.md as missing when absent', async () => {
    const result = await checkProductReadiness(makeProduct(), 'tok', fetchWithFiles(['AGENTS.md']));
    expect(result.ready).toBe(false);
    expect(result.missingContext).toHaveLength(1);
    expect(result.missingContext[0]).toMatchObject({ repo: 'test-org/test-repo', role: 'app' });
    expect(result.missingContext[0]!.missing).toContain('README.md');
  });

  it('reports agent instructions as missing when none of the accepted files exist', async () => {
    const result = await checkProductReadiness(makeProduct(), 'tok', fetchWithFiles(['README.md']));
    expect(result.ready).toBe(false);
    expect(result.missingContext[0]!.missing).toEqual([
      expect.stringContaining('agent instructions'),
    ]);
    expect(result.missingContext[0]!.missing[0]).toContain('AGENTS.md');
  });

  it('lists both files when the repo is empty', async () => {
    const result = await checkProductReadiness(makeProduct(), 'tok', fetchWithFiles([]));
    expect(result.ready).toBe(false);
    expect(result.missingContext[0]!.missing).toHaveLength(2);
  });

  it('only checks role:app repos — docs/infra repos are exempt', async () => {
    const product: Product = {
      ...makeProduct(),
      code_repos: [
        { url: 'https://github.com/test-org/app-repo', default_branch: 'main', role: 'app' },
        { url: 'https://github.com/test-org/docs-repo', default_branch: 'main', role: 'docs' },
        { url: 'https://github.com/test-org/infra-repo', default_branch: 'main', role: 'infra' },
      ],
    };
    const fetchFn = fetchWithFiles(['README.md', 'AGENTS.md']);
    const result = await checkProductReadiness(product, 'tok', fetchFn);

    expect(result.ready).toBe(true);
    // No request should have targeted the docs or infra repos.
    const urls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(urls.every((u) => u.includes('/app-repo/'))).toBe(true);
  });

  it('is vacuously ready when there are no app repos', async () => {
    const product: Product = {
      ...makeProduct(),
      code_repos: [
        { url: 'https://github.com/test-org/docs-repo', default_branch: 'main', role: 'docs' },
      ],
    };
    const fetchFn = fetchWithFiles([]);
    const result = await checkProductReadiness(product, 'tok', fetchFn);

    expect(result.ready).toBe(true);
    expect(result.missingContext).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('flags each non-ready app repo independently', async () => {
    const product: Product = {
      ...makeProduct(),
      code_repos: [
        { url: 'https://github.com/test-org/repo-a', default_branch: 'main', role: 'app' },
        { url: 'https://github.com/test-org/repo-b', default_branch: 'main', role: 'app' },
      ],
    };
    // Only repo-a is documented; repo-b has nothing.
    const fetchFn: FetchFn = vi.fn().mockImplementation((url: string) => {
      const isRepoA = (url as string).includes('/repo-a/');
      const wanted = (url as string).includes('README.md') || (url as string).includes('AGENTS.md');
      return Promise.resolve(isRepoA && wanted ? okResponse('x') : notFound());
    });

    const result = await checkProductReadiness(product, 'tok', fetchFn);

    expect(result.ready).toBe(false);
    expect(result.missingContext).toHaveLength(1);
    expect(result.missingContext[0]!.repo).toBe('test-org/repo-b');
  });

  it('reports an unparseable repo URL as unverifiable (does not silently pass)', async () => {
    const product: Product = {
      ...makeProduct(),
      code_repos: [{ url: 'https://gitlab.com/o/r', default_branch: 'main', role: 'app' }],
    };
    const fetchFn = fetchWithFiles([]);
    const result = await checkProductReadiness(product, 'tok', fetchFn);

    expect(result.ready).toBe(false);
    expect(result.missingContext[0]!.repo).toBe('https://gitlab.com/o/r');
    expect(result.missingContext[0]!.missing[0]).toContain('unverifiable');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports unverifiable when no GITHUB_TOKEN is configured', async () => {
    const fetchFn = fetchWithFiles(['README.md', 'AGENTS.md']);
    const result = await checkProductReadiness(makeProduct(), undefined, fetchFn);

    expect(result.ready).toBe(false);
    expect(result.missingContext[0]!.missing[0]).toContain('GITHUB_TOKEN');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('propagates a non-404 fetch error (infra failure, not a precondition failure)', async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as Response);

    await expect(checkProductReadiness(makeProduct(), 'tok', fetchFn)).rejects.toThrow(/403/);
  });
});
