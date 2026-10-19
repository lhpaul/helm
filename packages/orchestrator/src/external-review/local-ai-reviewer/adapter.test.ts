import { describe, expect, it } from 'vitest';
import {
  executeLocalAiReview,
  parseLocalAiReview,
  createLocalAiReviewerAdapter,
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
  it('rejects command success without a fresh evidence file', async () => {
    await expect(executeLocalAiReview({ ...input, command: 'echo' })).rejects.toThrow();
  });
});
