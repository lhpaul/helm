import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTests, getIssueTrackerAdapter } from './index.js';
import { GitHubProjectsAdapter, LinearAdapter } from '@helm/adapters';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@helm/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@helm/shared')>();
  return { ...real, parseProductConfigFromFile: vi.fn() };
});

vi.mock('@helm/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@helm/storage')>();
  return {
    ...real,
    ensureDataDir: vi.fn().mockResolvedValue({ items: '/tmp/items', jobs: '/tmp/jobs' }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const GITHUB_CONFIG = {
  helm_version: '0' as const,
  product: { slug: 'helm', name: 'Helm' },
  issue_tracker: {
    provider: 'github_projects' as const,
    org: 'test-org',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [
    { url: 'https://github.com/test/repo', default_branch: 'main', role: 'app' as const },
  ],
  knowledge_repo: { url: 'https://github.com/test/knowledge', default_branch: 'main' },
  workflow: {
    stages_enabled: ['discovery' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
  },
  specialists: {
    spec_writer: { runtime: 'claude_code' as const, model: 'm' },
    plan_writer: { runtime: 'claude_code' as const, model: 'm' },
    implementer: { runtime: 'claude_code' as const, model: 'm' },
    code_reviewer: { runtime: 'claude_code' as const, model: 'm' },
    security_reviewer: { runtime: 'claude_code' as const, model: 'm' },
    test_reviewer: { runtime: 'claude_code' as const, model: 'm' },
    remediation: { runtime: 'claude_code' as const, model: 'm' },
  },
};

const LINEAR_CONFIG = {
  ...GITHUB_CONFIG,
  issue_tracker: {
    provider: 'linear' as const,
    api_key_env: 'LINEAR_API_KEY',
    team_key: 'MOM',
    webhook_secret_env: 'LINEAR_WEBHOOK_SECRET',
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getIssueTrackerAdapter factory', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
    process.env.HELM_KNOWLEDGE_REPO_PATH = '/fake/knowledge';
  });

  afterEach(() => {
    delete process.env.HELM_KNOWLEDGE_REPO_PATH;
    delete process.env.GITHUB_TOKEN;
    delete process.env.LINEAR_API_KEY;
  });

  it('returns GitHubProjectsAdapter when provider is github_projects', async () => {
    const { parseProductConfigFromFile } = await import('@helm/shared');
    vi.mocked(parseProductConfigFromFile).mockResolvedValue(GITHUB_CONFIG);
    process.env.GITHUB_TOKEN = 'ghp_test_token';

    const adapter = await getIssueTrackerAdapter();
    expect(adapter).toBeInstanceOf(GitHubProjectsAdapter);
  });

  it('returns LinearAdapter when provider is linear', async () => {
    const { parseProductConfigFromFile } = await import('@helm/shared');
    vi.mocked(parseProductConfigFromFile).mockResolvedValue(LINEAR_CONFIG);
    process.env.LINEAR_API_KEY = 'lin_api_test_key';

    const adapter = await getIssueTrackerAdapter();
    expect(adapter).toBeInstanceOf(LinearAdapter);
  });

  it('throws when GITHUB_TOKEN is missing for github_projects', async () => {
    const { parseProductConfigFromFile } = await import('@helm/shared');
    vi.mocked(parseProductConfigFromFile).mockResolvedValue(GITHUB_CONFIG);
    delete process.env.GITHUB_TOKEN;

    await expect(getIssueTrackerAdapter()).rejects.toThrow('GITHUB_TOKEN');
  });

  it('throws when LINEAR_API_KEY env var is missing for linear', async () => {
    const { parseProductConfigFromFile } = await import('@helm/shared');
    vi.mocked(parseProductConfigFromFile).mockResolvedValue(LINEAR_CONFIG);
    delete process.env.LINEAR_API_KEY;

    await expect(getIssueTrackerAdapter()).rejects.toThrow('LINEAR_API_KEY');
  });

  it('returns the same singleton on repeated calls', async () => {
    const { parseProductConfigFromFile } = await import('@helm/shared');
    vi.mocked(parseProductConfigFromFile).mockResolvedValue(LINEAR_CONFIG);
    process.env.LINEAR_API_KEY = 'lin_api_test_key';

    const a = await getIssueTrackerAdapter();
    const b = await getIssueTrackerAdapter();
    expect(a).toBe(b);
    expect(parseProductConfigFromFile).toHaveBeenCalledTimes(1);
  });
});
