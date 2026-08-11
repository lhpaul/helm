import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ExternalReviewContext } from '../types.js';
import {
  CodeRabbitExternalReviewAdapter,
  normalizeCodeRabbitReviewPayload,
  resolveCodeRabbitReviewConfig,
} from './adapter.js';
import type { CodeRabbitReviewPayload } from './types.js';

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
  review: {
    external: {
      provider: 'coderabbit' as const,
      coderabbit: {
        status_contexts: ['CodeRabbit'],
        trusted_identities: ['coderabbitai[bot]'],
        blocking_severities: ['critical', 'high', 'medium'],
      },
    },
  },
} satisfies Product;

const ctx: ExternalReviewContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 42,
  prUrl: 'https://github.com/o/r/pull/42',
  defaultBranch: 'main',
};

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): CodeRabbitReviewPayload {
  return JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', name), 'utf8'),
  ) as CodeRabbitReviewPayload;
}

describe('CodeRabbitExternalReviewAdapter', () => {
  it('normalizes a successful status without findings to clean', async () => {
    const payload = loadFixture('status-clean.json');
    const adapter = new CodeRabbitExternalReviewAdapter(baseProduct, {
      loadCodeRabbitReview: vi.fn(() => payload),
    });

    await expect(adapter.reviewPullRequest(ctx)).resolves.toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
  });

  it('normalizes pending status to deferred', () => {
    const result = normalizeCodeRabbitReviewPayload(
      loadFixture('status-pending.json'),
      resolveCodeRabbitReviewConfig(baseProduct),
    );

    expect(result).toEqual({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'coderabbit status pending',
    });
  });

  it('maps unresolved review comments to needs_fixes', () => {
    const result = normalizeCodeRabbitReviewPayload(
      loadFixture('review-comment-blocking.json'),
      resolveCodeRabbitReviewConfig(baseProduct),
    );

    expect(result.status).toBe('needs_fixes');
    if (result.status === 'needs_fixes') {
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.path).toBe('apps/api/src/routes/webhooks.ts');
      expect(result.blockers[0]?.severity).toBe('high');
      expect(result.blockers[0]?.id).toMatch(/^coderabbit:/);
    }
  });

  it('skips rate-limited success statuses', () => {
    const result = normalizeCodeRabbitReviewPayload(
      loadFixture('status-rate-limited.json'),
      resolveCodeRabbitReviewConfig(baseProduct),
    );
    expect(result).toEqual({ status: 'skipped', reason: 'unavailable' });
  });
});
