import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { ExternalReviewContext } from '../types.js';
import { HaystackExternalReviewAdapter } from './adapter.js';
import type { HaystackTriageJson } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}

const baseProduct = {
  helm_version: '0' as const,
  product: { slug: 'test', name: 'Test' },
  issue_tracker: { provider: 'github_projects' as const, org: 'o', project_number: 1 },
  code_repos: [{ url: 'https://github.com/o/r', default_branch: 'main', role: 'app' as const }],
  knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
  workflow: {
    stages_enabled: ['code-review' as const],
    designer_gate: 'skip' as const,
    qa_gate: 'skip' as const,
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
      provider: 'haystack' as const,
      haystack: { major_is_blocking: false, poll_interval_sec: 1, timeout_sec: 5 },
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

describe('HaystackExternalReviewAdapter', () => {
  it('returns clean with advisories when only non-blocking findings exist', async () => {
    const triage = loadFixture<HaystackTriageJson>('triage-clean-advisory.json');
    const runHaystack = vi.fn(async (args: string[]) => {
      if (args[0] === 'triage') {
        return { stdout: JSON.stringify(triage), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const adapter = new HaystackExternalReviewAdapter(baseProduct, { runHaystack });
    const result = await adapter.reviewPullRequest(ctx);

    expect(result).toEqual({
      status: 'clean',
      blockers: [],
      advisories: [
        expect.objectContaining({
          id: 'haystack:CHANGELOG.md:Rules violation:12',
          blocking: false,
          severity: 'low',
          path: 'CHANGELOG.md',
          summary: 'CHANGELOG entry placement',
        }),
      ],
      policy: undefined,
    });
  });

  it('returns needs_fixes with stable blocker ids', async () => {
    const triage = loadFixture<HaystackTriageJson>('triage-needs-fixes.json');
    const runHaystack = vi.fn(async (args: string[]) => {
      if (args[0] === 'triage') {
        return { stdout: JSON.stringify(triage), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const adapter = new HaystackExternalReviewAdapter(baseProduct, { runHaystack });
    const result = await adapter.reviewPullRequest(ctx);

    expect(result.status).toBe('needs_fixes');
    if (result.status !== 'needs_fixes') return;
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toMatchObject({
      id: 'haystack:finding-9001',
      blocking: true,
      severity: 'critical',
      path: 'apps/api/src/routes/items.ts',
    });
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]?.id).toBe('haystack:apps/api/src/routes/items.ts:Minor:102');
  });

  it('polls until triage completes and escalates on pending_timeout', async () => {
    const pending = loadFixture<HaystackTriageJson>('triage-pending.json');
    let now = 0;
    const runHaystack = vi.fn(async () => ({
      stdout: JSON.stringify(pending),
      stderr: '',
      exitCode: 0,
    }));
    const sleep = vi.fn(async () => {
      now += 1000;
    });

    const adapter = new HaystackExternalReviewAdapter(baseProduct, {
      runHaystack,
      sleep,
      now: () => now,
    });
    const result = await adapter.reviewPullRequest(ctx);

    expect(result).toEqual({ status: 'escalate', reason: 'haystack pending_timeout' });
    expect(runHaystack.mock.calls.length).toBeGreaterThan(1);
    expect(sleep).toHaveBeenCalled();
  });

  it('skips when haystack reports status=none', async () => {
    const none = loadFixture<HaystackTriageJson>('triage-none.json');
    const runHaystack = vi.fn(async () => ({
      stdout: JSON.stringify(none),
      stderr: '',
      exitCode: 0,
    }));

    const adapter = new HaystackExternalReviewAdapter(baseProduct, { runHaystack });
    const result = await adapter.reviewPullRequest(ctx);

    expect(result).toEqual({ status: 'skipped', reason: 'unavailable' });
  });

  it('skips on auth errors without retrying', async () => {
    const unauthorized = loadFixture<HaystackTriageJson>('triage-unauthorized.json');
    const runHaystack = vi.fn(async () => ({
      stdout: JSON.stringify(unauthorized),
      stderr: '',
      exitCode: 3,
    }));
    const sleep = vi.fn();

    const adapter = new HaystackExternalReviewAdapter(baseProduct, { runHaystack, sleep });
    const result = await adapter.reviewPullRequest(ctx);

    expect(result).toEqual({ status: 'skipped', reason: 'unavailable' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('surfaces policy human-review on clean triage when pr-status requires it', async () => {
    const triage = loadFixture<HaystackTriageJson>('triage-clean-advisory.json');
    const prStatus = loadFixture('pr-status-needs-review.json');
    const runHaystack = vi.fn(async (args: string[]) => {
      if (args[0] === 'triage') {
        return { stdout: JSON.stringify(triage), stderr: '', exitCode: 0 };
      }
      return { stdout: JSON.stringify(prStatus), stderr: '', exitCode: 0 };
    });

    const adapter = new HaystackExternalReviewAdapter(baseProduct, { runHaystack });
    const result = await adapter.reviewPullRequest(ctx);

    expect(result.status).toBe('clean');
    if (result.status !== 'clean') return;
    expect(result.policy).toEqual({
      needsHumanReview: true,
      disposition: 'policy-human-review',
    });
  });
});
