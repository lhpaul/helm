import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import { parsePullRequestRef, runExternalReviewIfConfigured } from './run.js';

const baseProduct = {
  helm_version: '0' as const,
  product: { slug: 'test', name: 'Test' },
  issue_tracker: {
    provider: 'github_projects' as const,
    org: 'o',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' as const }],
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
  workflow: {
    stages_enabled: ['code-review' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
    readiness_gate: 'skip' as const,
    final_stage: 'released' as const,
  },
  specialists: {
    'spec-writer': { runtime: 'claude_code' as const, model: 'm' },
    'plan-writer': { runtime: 'claude_code' as const, model: 'm' },
    implementer: { runtime: 'claude_code' as const, model: 'm' },
    'code-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'security-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'test-reviewer': { runtime: 'claude_code' as const, model: 'm' },
    'spec-remediator': { runtime: 'claude_code' as const, model: 'm' },
    'plan-remediator': { runtime: 'claude_code' as const, model: 'm' },
    'code-remediator': { runtime: 'claude_code' as const, model: 'm' },
  },
} satisfies Product;

const PR_URL = 'https://github.com/o/r/pull/42';

describe('parsePullRequestRef', () => {
  it('parses a standard GitHub PR URL', () => {
    expect(parsePullRequestRef(PR_URL)).toEqual({
      owner: 'o',
      repo: 'r',
      prNumber: 42,
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parsePullRequestRef('https://gitlab.com/o/r/-/merge_requests/1')).toBeNull();
  });

  it('returns null for malformed GitHub URLs', () => {
    expect(parsePullRequestRef('https://github.com/o/r/issues/42')).toBeNull();
  });
});

describe('runExternalReviewIfConfigured', () => {
  it('skips when review.external.provider is omitted', async () => {
    await expect(runExternalReviewIfConfigured(baseProduct, PR_URL)).resolves.toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
  });

  it('skips when code_repos is empty', async () => {
    const product: Product = {
      ...baseProduct,
      code_repos: [],
      review: { external: { provider: 'coderabbit' } },
    };
    await expect(runExternalReviewIfConfigured(product, PR_URL)).resolves.toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
  });

  it('skips when the PR URL cannot be parsed', async () => {
    const product: Product = {
      ...baseProduct,
      review: { external: { provider: 'coderabbit' } },
    };
    await expect(runExternalReviewIfConfigured(product, 'not-a-url')).resolves.toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
  });

  it('delegates to Bugbot adapter when provider is bugbot', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'bugbot',
          bugbot: {
            check_names: ['Bugbot'],
            trusted_app_identities: ['bugbot'],
            blocking_severities: ['critical', 'high', 'medium'],
          },
        },
      },
    };
    const loadBugbotReview = vi.fn(() => ({
      checkRun: { name: 'Bugbot / Review', status: 'completed', conclusion: 'success' },
    }));

    await expect(
      runExternalReviewIfConfigured(product, PR_URL, { loadBugbotReview }),
    ).resolves.toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
    expect(loadBugbotReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      prNumber: 42,
      prUrl: PR_URL,
      defaultBranch: 'main',
    });
  });

  it('delegates to CodeRabbit adapter when provider is coderabbit', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'coderabbit',
          coderabbit: {
            status_contexts: ['CodeRabbit'],
            trusted_identities: ['coderabbitai[bot]'],
            blocking_severities: ['critical', 'high', 'medium'],
          },
        },
      },
    };
    const loadCodeRabbitReview = vi.fn(() => ({
      status: { context: 'CodeRabbit', state: 'success', description: 'Review completed' },
    }));

    await expect(
      runExternalReviewIfConfigured(product, PR_URL, { loadCodeRabbitReview }),
    ).resolves.toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
    expect(loadCodeRabbitReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      prNumber: 42,
      prUrl: PR_URL,
      defaultBranch: 'main',
    });
  });

  it('delegates to the Codex GitHub adapter when provider is codex-github', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'codex-github',
          codex_github: {
            trusted_identities: ['chatgpt-codex-connector[bot]'],
            check_names: ['Codex'],
            blocking_severities: ['critical', 'high'],
          },
        },
      },
    };
    const loadCodexGitHubReview = vi.fn(() => ({
      review: {
        state: 'COMMENTED',
        commit_id: 'abc1234',
        body: "Codex Review: didn't find any major issues.",
        user: { login: 'chatgpt-codex-connector[bot]' },
      },
    }));

    await expect(
      runExternalReviewIfConfigured(product, PR_URL, { loadCodexGitHubReview }),
    ).resolves.toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
    expect(loadCodexGitHubReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      prNumber: 42,
      prUrl: PR_URL,
      defaultBranch: 'main',
    });
  });

  it('passes the locked target revision to the external review context', async () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'bugbot',
          bugbot: {
            check_names: ['Bugbot'],
            trusted_app_identities: ['bugbot'],
            blocking_severities: ['critical', 'high', 'medium'],
          },
        },
      },
    };
    const loadBugbotReview = vi.fn(() => ({
      checkRun: { name: 'Bugbot / Review', status: 'completed', conclusion: 'success' },
    }));

    await runExternalReviewIfConfigured(product, PR_URL, { loadBugbotReview }, 'abc1234');

    expect(loadBugbotReview).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRevision: 'abc1234',
      }),
    );
  });
});

it('runs local AI review with defaults and exact target revision', async () => {
  const targetRevision = 'a'.repeat(40);
  const product: Product = {
    ...baseProduct,
    review: { external: { provider: 'local-ai-reviewer' } },
  };
  const executeLocalAiReview = vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: `RESULT=clean\nREVIEWED_HEAD=${targetRevision}\nBLOCKING_COUNT=0\n`,
    evidence: {
      schema_version: 'local_ai_reviewer_evidence.v1',
      owner: 'o',
      repo: 'r',
      pr_number: 42,
      result: 'clean',
      reviewed_head: targetRevision,
      counts: { blocking: 0 },
    },
  });
  await expect(
    runExternalReviewIfConfigured(product, PR_URL, { executeLocalAiReview }, targetRevision),
  ).resolves.toMatchObject({ status: 'clean' });
  expect(executeLocalAiReview).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'local-ai-reviewer.sh',
      backend: 'codex',
      mode: 'ordinary',
      timeoutSec: 900,
      ctx: expect.objectContaining({ targetRevision }),
    }),
  );
});

describe('runExternalReviewIfConfigured — knowledge artifact PRs (#120)', () => {
  const targetRevision = 'a'.repeat(40);
  const KNOWLEDGE_PR = 'https://github.com/o/k/pull/7';
  const withArtifacts = (artifacts?: { enabled: boolean; command?: string }): Product => ({
    ...baseProduct,
    review: {
      external: {
        provider: 'local-ai-reviewer',
        local_ai_reviewer: {
          command: 'impl-cmd',
          backend: 'codex',
          timeout_sec: 900,
          mode: 'ordinary',
          ...(artifacts
            ? { artifacts: { enabled: artifacts.enabled, command: artifacts.command } }
            : {}),
        },
      },
    },
  });
  const clean = (pr: number, owner = 'o', repo = 'k') =>
    vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: `RESULT=clean\nREVIEWED_HEAD=${targetRevision}\nBLOCKING_COUNT=0\n`,
      evidence: {
        schema_version: 'local_ai_reviewer_evidence.v1',
        owner,
        repo,
        pr_number: pr,
        result: 'clean',
        reviewed_head: targetRevision,
        counts: { blocking: 0 },
      },
    });

  it('runs the artifact command on the knowledge repo when enabled', async () => {
    const executeLocalAiReview = clean(7);
    const checkReviewMd = vi.fn().mockResolvedValue('present');
    await expect(
      runExternalReviewIfConfigured(
        withArtifacts({ enabled: true, command: 'knowledge-cmd' }),
        KNOWLEDGE_PR,
        { executeLocalAiReview, checkReviewMd },
        targetRevision,
        'spec',
      ),
    ).resolves.toMatchObject({ status: 'clean' });
    expect(executeLocalAiReview).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'knowledge-cmd',
        ctx: expect.objectContaining({ artifactKind: 'spec', owner: 'o', repo: 'k' }),
      }),
    );
    expect(checkReviewMd).toHaveBeenCalledOnce();
  });

  it('falls back to the base command when no artifact command is set', async () => {
    const executeLocalAiReview = clean(7);
    await runExternalReviewIfConfigured(
      withArtifacts({ enabled: true }),
      KNOWLEDGE_PR,
      { executeLocalAiReview, checkReviewMd: async () => 'unknown' },
      targetRevision,
      'plan',
    );
    expect(executeLocalAiReview).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'impl-cmd' }),
    );
  });

  it.each([undefined, { enabled: false }])(
    'skips artifact PRs unless enabled (%j)',
    async (cfg) => {
      const executeLocalAiReview = clean(7);
      await expect(
        runExternalReviewIfConfigured(
          withArtifacts(cfg),
          KNOWLEDGE_PR,
          { executeLocalAiReview },
          targetRevision,
          'spec',
        ),
      ).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
      expect(executeLocalAiReview).not.toHaveBeenCalled();
    },
  );

  it('skips disabled artifact review even without a target revision', async () => {
    const executeLocalAiReview = clean(7);
    await expect(
      runExternalReviewIfConfigured(
        withArtifacts(),
        KNOWLEDGE_PR,
        { executeLocalAiReview },
        undefined,
        'spec',
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(executeLocalAiReview).not.toHaveBeenCalled();
  });

  it('escalates review_md_missing for the codex backend without running the companion (#134)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executeLocalAiReview = clean(7);
    await expect(
      runExternalReviewIfConfigured(
        withArtifacts({ enabled: true }),
        KNOWLEDGE_PR,
        { executeLocalAiReview, checkReviewMd: async () => 'missing' },
        targetRevision,
        'spec',
      ),
    ).resolves.toEqual({ status: 'escalate', reason: 'review_md_missing' });
    expect(executeLocalAiReview).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not check REVIEW.md for the http backend', async () => {
    const product = withArtifacts({ enabled: true });
    product.review!.external!.local_ai_reviewer!.backend = 'http';
    const checkReviewMd = vi.fn();
    await runExternalReviewIfConfigured(
      product,
      KNOWLEDGE_PR,
      { executeLocalAiReview: clean(7), checkReviewMd },
      targetRevision,
      'spec',
    );
    expect(checkReviewMd).not.toHaveBeenCalled();
  });

  it('refuses an artifact PR outside the configured knowledge repo', async () => {
    const executeLocalAiReview = clean(42);
    await expect(
      runExternalReviewIfConfigured(
        withArtifacts({ enabled: true }),
        PR_URL,
        { executeLocalAiReview },
        targetRevision,
        'spec',
      ),
    ).resolves.toMatchObject({ status: 'skipped', reason: 'unavailable' });
    expect(executeLocalAiReview).not.toHaveBeenCalled();
  });

  it('leaves implementation PRs unchanged even with artifacts enabled', async () => {
    const executeLocalAiReview = clean(42, 'o', 'r');
    const checkReviewMd = vi.fn();
    await expect(
      runExternalReviewIfConfigured(
        withArtifacts({ enabled: true, command: 'knowledge-cmd' }),
        PR_URL,
        { executeLocalAiReview, checkReviewMd },
        targetRevision,
      ),
    ).resolves.toMatchObject({ status: 'clean' });
    expect(executeLocalAiReview).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'impl-cmd' }),
    );
    expect(checkReviewMd).not.toHaveBeenCalled();
  });
});
