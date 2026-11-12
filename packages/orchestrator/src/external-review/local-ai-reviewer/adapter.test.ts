import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DETERMINISTIC_COMPANION_REASONS,
  executeLocalAiReview,
  parseLocalAiReview,
  createLocalAiReviewerAdapter,
  sanitizeDiagnostic,
} from './adapter.js';
import type { Product } from '@helm/shared';

const ctx = {
  owner: 'o',
  repo: 'r',
  prNumber: 42,
  prUrl: 'https://github.com/o/r/pull/42',
  defaultBranch: 'develop',
  targetRevision: 'a'.repeat(40),
};
function execution(result = 'clean', count = 0) {
  return {
    stdout: `RESULT=${result}\nREVIEWED_HEAD=${ctx.targetRevision}\nBLOCKING_COUNT=${count}\n`,
    exitCode: result === 'needs_fixes' ? 1 : 0,
    evidence: {
      schema_version: 'local_ai_reviewer_evidence.v1',
      owner: 'o',
      repo: 'r',
      pr_number: 42,
      reviewed_head: ctx.targetRevision,
      result,
      counts: { blocking: count },
    },
  };
}
const skipped = { status: 'skipped', reason: 'unavailable' };
describe('local AI review evidence', () => {
  it('passes only matching current-head terminal evidence', () => {
    expect(parseLocalAiReview(execution(), ctx)).toEqual({
      status: 'clean',
      blockers: [],
      advisories: [],
    });
  });
  it('normalizes blocker body and path with a stable identity', () => {
    const review = execution('needs_fixes', 1);
    review.stdout +=
      'BLOCKING_1_PATH=src/file.ts\nBLOCKING_1_LINE=12\nBLOCKING_1_BODY=Fix the bug\\nDetails\n';
    const result = parseLocalAiReview(review, ctx);
    expect(result).toMatchObject({
      status: 'needs_fixes',
      blockers: [
        { severity: 'high', blocking: true, path: 'src/file.ts', summary: 'Fix the bug\nDetails' },
      ],
    });
    expect(parseLocalAiReview(review, ctx)).toEqual(result);
  });
  it.each(['b'.repeat(40), '', 'a'.repeat(7)])(
    'rejects stale/missing/abbreviated artifact head %s',
    (head) => {
      const review = execution();
      review.evidence.reviewed_head = head;
      expect(parseLocalAiReview(review, ctx)).toMatchObject(skipped);
    },
  );
  it('rejects missing evidence', () => {
    expect(parseLocalAiReview({ ...execution(), evidence: null }, ctx)).toMatchObject(skipped);
  });
  it.each([
    'RESULT=clean\nBLOCKING_COUNT=0\n',
    `RESULT=clean\nREVIEWED_HEAD=${'b'.repeat(40)}\nBLOCKING_COUNT=0\n`,
    execution().stdout + 'RESULT=clean\n',
    execution().stdout.replace('BLOCKING_COUNT=0', 'BLOCKING_COUNT=NaN'),
    execution().stdout + 'BLOCKING_1_BODY=hidden blocker\n',
  ])('rejects malformed, stale, contradictory or duplicate output', (stdout) => {
    expect(parseLocalAiReview({ ...execution(), stdout }, ctx)).toMatchObject(skipped);
  });
  it.each(['waiting_on_reviewer', 'skipped', 'escalate', 'needs_rerun'])(
    'does not pass %s',
    (result) => {
      expect(parseLocalAiReview(execution(result), ctx)).toMatchObject(skipped);
    },
  );
  it('rejects clean output after failed command', () => {
    expect(parseLocalAiReview({ ...execution(), exitCode: 1 }, ctx)).toMatchObject(skipped);
  });
  it('rejects conflicting artifact verdict/count/identity', () => {
    for (const patch of [
      { result: 'needs_fixes' },
      { counts: { blocking: 1 } },
      { owner: 'other' },
      { pr_number: 43 },
      { schema_version: 'unknown' },
    ]) {
      expect(
        parseLocalAiReview(
          { ...execution(), evidence: { ...execution().evidence, ...patch } },
          ctx,
        ),
      ).toMatchObject(skipped);
    }
  });
  it('rejects missing blocker bodies and contradictory clean counts', () => {
    expect(parseLocalAiReview(execution('needs_fixes', 1), ctx)).toMatchObject(skipped);
    expect(parseLocalAiReview(execution('clean', 1), ctx)).toMatchObject(skipped);
    expect(parseLocalAiReview(execution('needs_fixes', 0), ctx)).toMatchObject(skipped);
  });
  it('fails closed on executor failure and absent target without calling executor', async () => {
    let calls = 0;
    const adapter = createLocalAiReviewerAdapter({} as Product, {
      executeLocalAiReview: async () => {
        calls++;
        throw new Error('private path');
      },
    });
    expect(await adapter.reviewPullRequest({ ...ctx, targetRevision: undefined })).toMatchObject(
      skipped,
    );
    expect(calls).toBe(0);
    expect(await adapter.reviewPullRequest(ctx)).toMatchObject(skipped);
    expect(calls).toBe(1);
  });
});
describe('local command execution', () => {
  const input = { ctx, backend: 'codex' as const, mode: 'ordinary' as const, timeoutSec: 1 };
  it('aborts an actual hung process and does not consume partial output', async () => {
    const start = Date.now();
    await expect(
      executeLocalAiReview({ ...input, command: "sh -c 'echo RESULT=clean; sleep 20'" }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(4000);
  }, 5000);
  it('passes PR arguments and backend/mode, reads fresh evidence', async () => {
    const command = `node -e 'const fs = require("node:fs"); fs.writeFileSync(process.env.LOCAL_AI_REVIEWER_EVIDENCE_FILE, JSON.stringify({args:process.argv.slice(1),backend:process.env.LOCAL_AI_REVIEWER_BACKEND,mode:process.env.LOCAL_AI_REVIEWER_MODE})); console.log("RESULT=clean")' --`;
    const result = await executeLocalAiReview({ ...input, command });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'RESULT=clean\n',
      evidence: {
        args: ['42', 'o', 'r', '--timeout', '1', '--repo-root', '.'],
        backend: 'codex',
        mode: 'ordinary',
      },
    });
  });
  it('returns null evidence when the command wrote no evidence file', async () => {
    const result = await executeLocalAiReview({ ...input, command: 'echo' });
    expect(result.evidence).toBeNull();
    expect(parseLocalAiReview(result, ctx)).toEqual({
      ...skipped,
      providerReason: 'missing_evidence',
    });
  });
  it('captures the companion RESULT/REASON and a bounded stderr tail without evidence', async () => {
    const command = `sh -c 'head -c 10000 /dev/zero | tr "\\0" x >&2; echo "ERROR: REVIEW.md is required" >&2; echo RESULT=escalate; echo REASON=review_contract_missing; exit 2' --`;
    const result = await executeLocalAiReview({ ...input, command });
    expect(result).toMatchObject({ exitCode: 2, evidence: null });
    expect(result.stdout).toContain('REASON=review_contract_missing');
    expect(result.stderr!.length).toBeLessThanOrEqual(4096);
    expect(result.stderr).toContain('REVIEW.md is required');
  });
});

describe('companion failure reasons (#134)', () => {
  afterEach(() => vi.restoreAllMocks());
  function failure(result: string, reason: string, exitCode: number) {
    return { stdout: `RESULT=${result}\nREASON=${reason}\n`, exitCode, evidence: null };
  }
  it.each([...DETERMINISTIC_COMPANION_REASONS].filter((r) => r !== 'review_md_missing'))(
    'escalates deterministic reason %s without evidence instead of masking it',
    (reason) => {
      expect(parseLocalAiReview(failure('escalate', reason, 2), ctx)).toEqual({
        status: 'escalate',
        reason,
      });
    },
  );
  it.each([
    ['escalate', 'quota_exhausted', 2],
    ['escalate', 'head_mismatch', 2],
    ['escalate', 'malformed_output', 2],
    ['escalate', 'something_new', 2],
    ['waiting_on_reviewer', 'reviewer-no-verdict-yet', 4],
    ['skipped', 'disabled_by_config', 3],
  ])('keeps %s/%s retryable with the real reason', (result, reason, exitCode) => {
    expect(parseLocalAiReview(failure(result, reason, exitCode), ctx)).toEqual({
      ...skipped,
      providerReason: reason,
    });
  });
  it('does not escalate a deterministic reason with an inconsistent exit code', () => {
    expect(parseLocalAiReview(failure('escalate', 'review_contract_missing', 0), ctx)).toEqual({
      ...skipped,
      providerReason: 'review_contract_missing',
    });
  });
  it('never propagates a non-slug reason', () => {
    expect(parseLocalAiReview(failure('escalate', 'token=abc /Users/x/secret', 2), ctx)).toEqual({
      ...skipped,
      providerReason: 'no_terminal_verdict',
    });
  });
  it('escalates a real companion missing REVIEW.md once, with no evidence file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const command = `sh -c 'echo "ERROR: REVIEW.md is required" >&2; echo RESULT=escalate; echo REASON=review_contract_missing; exit 2' --`;
    const adapter = createLocalAiReviewerAdapter({
      review: { external: { local_ai_reviewer: { command, timeout_sec: 5 } } },
    } as unknown as Product);
    expect(await adapter.reviewPullRequest(ctx)).toEqual({
      status: 'escalate',
      reason: 'review_contract_missing',
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('escalate (review_contract_missing)'),
      expect.objectContaining({
        result: 'escalate',
        companionReason: 'review_contract_missing',
        exitCode: 2,
        stderrTail: expect.stringContaining('REVIEW.md is required'),
      }),
    );
  });
  it('escalates the review_md_missing preflight without running the companion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const adapter = createLocalAiReviewerAdapter(
      {
        review: { external: { local_ai_reviewer: { artifacts: { enabled: true } } } },
      } as unknown as Product,
      {
        checkReviewMd: async () => 'missing',
        executeLocalAiReview: async () => {
          calls++;
          throw new Error('unreachable');
        },
      },
    );
    expect(await adapter.reviewPullRequest({ ...ctx, artifactKind: 'spec' })).toEqual({
      status: 'escalate',
      reason: 'review_md_missing',
    });
    expect(calls).toBe(0);
  });
  it('logs a redacted stderr tail on execution failure, never in the result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createLocalAiReviewerAdapter({} as Product, {
      executeLocalAiReview: async () => {
        throw Object.assign(new Error('execution_unavailable'), {
          stderr: 'GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + ' at /Users/someone/checkout',
        });
      },
    });
    const outcome = await adapter.reviewPullRequest(ctx);
    expect(outcome).toEqual({ ...skipped, providerReason: 'execution_unavailable' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('ghp_');
    expect(logged).not.toContain('/Users/someone');
    expect(logged).toContain('[REDACTED]');
  });
});

describe('sanitizeDiagnostic', () => {
  it('redacts tokens, credentials, URLs with userinfo and local paths, and bounds length', () => {
    const text = sanitizeDiagnostic(
      [
        'ghp_' + 'b'.repeat(36),
        'github_pat_' + 'c'.repeat(30),
        'Authorization: Bearer abc.def',
        'api_key=sk-' + 'd'.repeat(20),
        'https://user:pw@github.com/o/r',
        '/home/someone/x',
        '\x1b[31mred\x1b[0m',
      ].join('\n'),
    );
    expect(text).not.toMatch(/ghp_|github_pat_|abc\.def|sk-d|user:pw|\/home\/someone|\x1b/);
    expect(text).toContain('red');
    expect(sanitizeDiagnostic('x'.repeat(5000)).length).toBe(2048);
  });
});
