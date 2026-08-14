import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  formatReviewLoopEscalationComment,
  upsertReviewLoopEscalationComment,
  REVIEW_LOOP_ESCALATION_MARKER,
} from './escalation-comment.js';
import type { RunGh } from '../specialists/git-helpers.js';

const PR_URL = 'https://github.com/test-org/test-repo/pull/42';

describe('formatReviewLoopEscalationComment', () => {
  it('includes marker, reason, and external signal', () => {
    const body = formatReviewLoopEscalationComment({
      reason: 'external_repeated_skip',
      message: 'External review skipped 2 time(s) (unavailable); escalating per stop-rule',
      cyclesCompleted: 2,
      externalReason: 'unavailable',
    });

    expect(body).toContain(REVIEW_LOOP_ESCALATION_MARKER);
    expect(body).toContain('`external_repeated_skip`');
    expect(body).toContain('External signal: `unavailable`');
    expect(body).toContain('Cycles completed: 2');
  });

  it('renders the lifetime lane counters when the caller knows them', () => {
    // The comment is updated in place, so the budget state has to be legible
    // from the current body alone (ADR-042 §5).
    const body = formatReviewLoopEscalationComment({
      reason: 'max_cycles_cumulative',
      message: 'Review loop escalated: lifetime review budget exhausted',
      cyclesCompleted: 2,
      cumulative: { cyclesTotal: 6, maxCyclesCumulative: 6 },
    });

    expect(body).toContain(
      'Lifetime cycles for this lane: 6 completed, budget max_cycles_cumulative=6',
    );
  });

  it('omits the lifetime line when no cumulative counters are given', () => {
    const body = formatReviewLoopEscalationComment({
      reason: 'adjudication_conflict',
      message: 'Review loop escalated: review-adjudicator requires human decisions',
      cyclesCompleted: 1,
    });

    expect(body).not.toContain('Lifetime cycles');
  });
});

/**
 * gh stub that stores the PR's comments the way GitHub would: a create appends,
 * a PATCH rewrites the targeted comment from its `--input` payload. Applying the
 * payload is what lets a test assert the *stored* body, not just that a PATCH
 * was sent.
 */
function makeGhStub(existing: { id: number; body: string; created_at: string }[]) {
  const calls: string[][] = [];
  const runGh: RunGh = vi.fn().mockImplementation(async (args: string[]) => {
    calls.push([...args]);
    if (args[0] === 'api' && args[2] === '--paginate') {
      return { stdout: JSON.stringify(existing) };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      existing.push({
        id: 100 + existing.length,
        body: args[args.indexOf('--body') + 1]!,
        created_at: `2026-08-14T0${existing.length}:00:00Z`,
      });
    }
    if (args[0] === 'api' && args.includes('PATCH')) {
      const payloadPath = args[args.indexOf('--input') + 1]!;
      const { body } = JSON.parse(await readFile(payloadPath, 'utf8')) as { body: string };
      const commentId = Number(args[1]!.split('/').at(-1));
      const target = existing.find((comment) => comment.id === commentId);
      if (target) target.body = body;
    }
    return { stdout: '' };
  });
  return { runGh, calls, existing };
}

describe('upsertReviewLoopEscalationComment', () => {
  const escalate = (runGh: RunGh, cyclesTotal: number) =>
    upsertReviewLoopEscalationComment({
      prUrl: PR_URL,
      githubToken: 'test-token',
      reason: 'max_cycles_cumulative',
      message: 'Review loop escalated: lifetime review budget exhausted',
      cyclesCompleted: 1,
      cumulative: { cyclesTotal, maxCyclesCumulative: 6 },
      runGh,
    });

  it('creates the comment on the first escalation', async () => {
    const gh = makeGhStub([]);

    await escalate(gh.runGh, 6);

    const created = gh.calls.find((args) => args[0] === 'pr' && args[1] === 'comment');
    expect(created).toBeDefined();
    expect(created!.join(' ')).toContain(REVIEW_LOOP_ESCALATION_MARKER);
  });

  it('updates the same comment when a re-dispatch escalates again', async () => {
    // The bug this closes: a lane whose budget is spent re-escalates on every
    // re-dispatch, so `postPRComment` piled identical comments on the PR.
    const gh = makeGhStub([]);

    await escalate(gh.runGh, 6);
    await escalate(gh.runGh, 7);

    const creates = gh.calls.filter((args) => args[0] === 'pr' && args[1] === 'comment');
    const patches = gh.calls.filter((args) => args.includes('PATCH'));
    expect(creates).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.join(' ')).toContain('issues/comments/100');
    // One comment, and its stored body carries the second escalation's counters.
    expect(gh.existing).toHaveLength(1);
    expect(gh.existing[0]!.body).toContain(
      'Lifetime cycles for this lane: 7 completed, budget max_cycles_cumulative=6',
    );
    expect(gh.existing[0]!.body).not.toContain('6 completed');
  });

  it('leaves the summary comment alone', async () => {
    const gh = makeGhStub([
      { id: 7, body: '<!-- helm:review-loop-summary -->\nadvisories', created_at: '2026-08-14' },
    ]);

    await escalate(gh.runGh, 6);

    expect(gh.calls.some((args) => args.includes('PATCH'))).toBe(false);
    expect(gh.calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(true);
  });
});
