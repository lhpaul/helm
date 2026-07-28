import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ExternalReviewContext } from '../types.js';
import {
  BugbotExternalReviewAdapter,
  normalizeBugbotReviewPayload,
  resolveBugbotReviewConfig,
} from './adapter.js';
import type { BugbotReviewPayload } from './types.js';

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
      provider: 'bugbot' as const,
      bugbot: {
        check_names: ['Bugbot', 'Bugbot / Review', 'Cursor / Bugbot'],
        trusted_app_identities: ['bugbot', 'cursor', 'cursor[bot]', 'cursor bugbot'],
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

function loadFixture(name: string): BugbotReviewPayload {
  return JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', name), 'utf8'),
  ) as BugbotReviewPayload;
}

describe('BugbotExternalReviewAdapter', () => {
  it('normalizes a successful check run to clean', async () => {
    const payload = loadFixture('check-run-clean.json');
    const adapter = new BugbotExternalReviewAdapter(baseProduct, {
      loadBugbotReview: vi.fn(() => payload),
    });

    await expect(adapter.reviewPullRequest(ctx)).resolves.toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
  });

  it('normalizes pending analysis to deferred', () => {
    const result = normalizeBugbotReviewPayload(
      loadFixture('check-run-pending.json'),
      resolveBugbotReviewConfig(baseProduct),
    );

    expect(result).toEqual({
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: 'bugbot check_run in_progress',
    });
  });

  it('keeps pending analysis escalatory when deferral is disabled', () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'bugbot',
          defer_when_pending: false,
          bugbot: {
            blocking_severities: ['critical', 'high', 'medium'],
            check_names: ['Bugbot'],
            trusted_app_identities: ['bugbot'],
          },
        },
      },
    };

    const result = normalizeBugbotReviewPayload(
      loadFixture('check-run-pending.json'),
      resolveBugbotReviewConfig(product),
    );

    expect(result).toEqual({ status: 'escalate', reason: 'bugbot check_run in_progress' });
  });

  it.each([
    ['unavailable payload', { unavailable: true }, { status: 'skipped', reason: 'unavailable' }],
    [
      'provider error payload',
      { error: 'api_unavailable' },
      { status: 'escalate', reason: 'bugbot api_unavailable' },
    ],
    [
      'skipped check-run conclusion',
      { checkRun: { status: 'completed', conclusion: 'skipped' } },
      { status: 'skipped', reason: 'unavailable' },
    ],
    [
      'non-success check-run conclusion',
      { checkRun: { status: 'completed', conclusion: 'failure' } },
      {
        status: 'needs_fixes',
        blockers: [
          expect.objectContaining({
            severity: 'high',
            blocking: true,
            summary: 'Bugbot check run concluded failure',
          }),
        ],
        advisories: [],
      },
    ],
  ] as const)('normalizes %s', (_name, payload, expected) => {
    expect(normalizeBugbotReviewPayload(payload, resolveBugbotReviewConfig(baseProduct))).toEqual(
      expected,
    );
  });

  it('maps review threads and annotations into normalized findings', () => {
    const result = normalizeBugbotReviewPayload(
      loadFixture('review-thread-blocking.json'),
      resolveBugbotReviewConfig(baseProduct),
    );

    expect(result.status).toBe('needs_fixes');
    if (result.status !== 'needs_fixes') return;
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toMatchObject({
      id: expect.stringMatching(/^bugbot:/),
      severity: 'high',
      blocking: true,
      path: 'apps/api/src/routes/webhooks.ts',
      summary: 'HIGH: Missing provider identity check before resuming deferred review.',
    });
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]).toMatchObject({
      severity: 'info',
      blocking: false,
      summary: 'Low priority follow-up',
    });
  });

  it('derives stable ledger IDs across duplicate deliveries', () => {
    const payload = loadFixture('review-thread-blocking.json');
    const config = resolveBugbotReviewConfig(baseProduct);
    const first = normalizeBugbotReviewPayload(payload, config);
    const second = normalizeBugbotReviewPayload(payload, config);

    expect(first.status).toBe('needs_fixes');
    expect(second.status).toBe('needs_fixes');
    if (first.status !== 'needs_fixes' || second.status !== 'needs_fixes') return;
    expect(second.blockers[0]?.id).toBe(first.blockers[0]?.id);
    expect(second.advisories[0]?.id).toBe(first.advisories[0]?.id);
  });

  it('ignores standalone comments when unresolved thread state is loaded', () => {
    const result = normalizeBugbotReviewPayload(
      {
        checkRun: { status: 'completed', conclusion: 'success' },
        reviewComments: [
          {
            id: 10,
            path: 'src/app.ts',
            line: 12,
            body: '**HIGH** stale resolved thread finding',
          },
        ],
        reviewThreads: [
          {
            id: 'thread-1',
            isResolved: true,
            path: 'src/app.ts',
            line: 12,
            comments: [
              {
                id: 10,
                body: '**HIGH** stale resolved thread finding',
              },
            ],
          },
        ],
      },
      resolveBugbotReviewConfig(baseProduct),
    );

    expect(result).toEqual({ status: 'clean', blockers: [], advisories: [] });
  });

  it('uses configured blocking severities', () => {
    const product: Product = {
      ...baseProduct,
      review: {
        external: {
          provider: 'bugbot',
          bugbot: {
            blocking_severities: ['critical', 'high'],
            check_names: ['Bugbot'],
            trusted_app_identities: ['bugbot'],
          },
        },
      },
    };
    const result = normalizeBugbotReviewPayload(
      {
        reviewComments: [
          {
            id: 1,
            path: 'x.ts',
            line: 1,
            body: '**MEDIUM**: Advisory under this product policy.',
          },
        ],
      },
      resolveBugbotReviewConfig(product),
    );

    expect(result).toEqual({
      status: 'clean',
      blockers: [],
      advisories: [
        expect.objectContaining({
          severity: 'medium',
          blocking: false,
        }),
      ],
    });
  });

  it('skips when no offline Bugbot loader is configured', async () => {
    const adapter = new BugbotExternalReviewAdapter(baseProduct);
    await expect(adapter.reviewPullRequest(ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
  });
});
