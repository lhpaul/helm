import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@helm/orchestrator';
import type { Job } from './job-store.js';
import { buildUsageReport, formatUsageTable } from './usage.js';

const NULL_TOKENS = {
  input: null,
  output: null,
  cacheRead: null,
  cacheCreation: null,
  reasoning: null,
};

function session(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    productSlug: 'p',
    externalId: 'issue_1',
    jobId: 'j',
    specialistId: 'x',
    stage: 'review',
    runtime: 'claude-code',
    model: null,
    startedAt: '2026-11-10T12:00:00.000Z',
    endedAt: '2026-11-10T12:00:10.000Z',
    durationMs: 10_000,
    status: 'done',
    tokens: { input: 100, output: 10, cacheRead: 50, cacheCreation: 5, reasoning: null },
    costUsd: 0.5,
    costSource: 'reported',
    ...over,
  };
}

const codexSession = (over: Partial<UsageRecord> = {}): UsageRecord =>
  session({
    runtime: 'codex',
    tokens: { input: 200, output: 20, cacheRead: 100, cacheCreation: null, reasoning: 7 },
    costUsd: null,
    costSource: 'unknown',
    ...over,
  });

let n = 0;
function job(specialistId: string, over: Partial<Job> = {}): Job {
  n += 1;
  return {
    jobId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    productSlug: 'p',
    externalId: 'issue_1',
    specialistId,
    status: 'done',
    startedAt: '2026-11-10T12:00:00.000Z',
    usage: [],
    usageCaptureFailures: 0,
    ...over,
  };
}

const q = { productSlug: 'p', externalId: 'issue_1' };

describe('buildUsageReport — item aggregate', () => {
  it('sums known values with a denominator per token counter and per cost', () => {
    const jobs = [
      job('implementer', { usage: [session({ stage: 'code' }), codexSession({ stage: 'code' })] }),
    ];
    const r = buildUsageReport(jobs, q);

    expect(r.sessions).toBe(2);
    expect(r.durationMs).toBe(20_000);
    expect(r.tokens.input).toEqual({ total: 300, sessionsReported: 2 });
    expect(r.tokens.cacheCreation).toEqual({ total: 5, sessionsReported: 1 });
    expect(r.tokens.reasoning).toEqual({ total: 7, sessionsReported: 1 });
    expect(r.costUsd).toEqual({ total: 0.5, sessionsWithCost: 1, sessionsUnknown: 1 });
    expect(r.notes).toEqual(['external-review: not measured']);
    expect(r.scope).toEqual({ productSlug: 'p', externalId: 'issue_1', from: null, to: null });
  });

  it('an all-Codex item reports total 0 with every session unknown, never a measured zero', () => {
    const jobs = [
      job('implementer', {
        usage: [codexSession({ stage: 'code' }), codexSession({ stage: 'code' })],
      }),
    ];
    const r = buildUsageReport(jobs, q);
    expect(r.costUsd).toEqual({ total: 0, sessionsWithCost: 0, sessionsUnknown: 2 });
  });

  it('ignores the legacy DispatchResult.costUsd (0 when unknown)', () => {
    const jobs = [
      job('implementer', {
        usage: [codexSession({ stage: 'code' })],
        result: { specialistId: 'implementer', status: 'done', costUsd: 99, durationMs: 1 },
      }),
    ];
    expect(buildUsageReport(jobs, q).costUsd.total).toBe(0);
  });

  it('a measured zero cost is counted as reported, not unknown', () => {
    const r = buildUsageReport(
      [job('spec-writer', { usage: [session({ stage: 'spec', costUsd: 0 })] })],
      q,
    );
    expect(r.costUsd).toEqual({ total: 0, sessionsWithCost: 1, sessionsUnknown: 0 });
  });

  it('counts null counters as unreported, not zero', () => {
    const r = buildUsageReport(
      [
        job('spec-writer', {
          usage: [
            session({ stage: 'spec', tokens: NULL_TOKENS, costUsd: null, costSource: 'unknown' }),
          ],
        }),
      ],
      q,
    );
    expect(r.tokens.input).toEqual({ total: 0, sessionsReported: 0 });
    expect(r.sessions).toBe(1);
  });

  it('breaks down by stage and omits stages with no jobs or sessions', () => {
    const jobs = [
      job('spec-writer', { usage: [session({ stage: 'spec' })] }),
      job('reviewer-fanout', {
        usage: [session(), session()],
        result: {
          specialistId: 'reviewer-fanout',
          status: 'done',
          costUsd: 0,
          durationMs: 1,
          cyclesCompleted: 3,
        },
      }),
    ];
    const r = buildUsageReport(jobs, q);
    expect(Object.keys(r.byStage).sort()).toEqual(['review', 'spec']);
    expect(r.byStage.review?.sessions).toBe(2);
    expect(r.byStage.spec?.sessions).toBe(1);
    expect(r.byStage.code).toBeUndefined();
  });

  it('attributes early spec/plan review sessions to spec/plan via the job, not to review', () => {
    const jobs = [
      job('spec-draft-reviewer', {
        usage: [session({ stage: 'spec', specialistId: 'reviewer-fanout' })],
        result: {
          specialistId: 'spec-draft-reviewer',
          status: 'done',
          costUsd: 0,
          durationMs: 1,
          cyclesCompleted: 4,
        },
      }),
      job('plan-draft-reviewer', {
        usage: [session({ stage: 'plan' })],
        result: {
          specialistId: 'plan-draft-reviewer',
          status: 'done',
          costUsd: 0,
          durationMs: 1,
          cyclesCompleted: 2,
        },
      }),
    ];
    const r = buildUsageReport(jobs, q);
    expect(r.byStage.review).toBeUndefined();
    expect(r.byStage.spec?.sessions).toBe(1);
    expect(r.byStage.plan?.sessions).toBe(1);
    // Early-loop cycles are not item review rounds.
    expect(r.reviewRounds).toBe(0);
  });

  it('sums review rounds from review-stage jobs cyclesCompleted; no review jobs → 0 and no entry', () => {
    const review = (cycles: number | undefined) =>
      job('reviewer-fanout', {
        result: {
          specialistId: 'reviewer-fanout',
          status: 'done',
          costUsd: 0,
          durationMs: 1,
          cyclesCompleted: cycles,
        },
      });
    expect(buildUsageReport([review(2), review(1), review(undefined)], q).reviewRounds).toBe(3);

    const none = buildUsageReport([job('implementer')], q);
    expect(none.reviewRounds).toBe(0);
    expect(none.byStage.review).toBeUndefined();
  });

  it('empty scope yields zeros and no stages', () => {
    const r = buildUsageReport([], q);
    expect(r.sessions).toBe(0);
    expect(r.byStage).toEqual({});
    expect(r.costUsd).toEqual({ total: 0, sessionsWithCost: 0, sessionsUnknown: 0 });
  });

  it('scopes by product and item', () => {
    const jobs = [
      job('spec-writer', { usage: [session()] }),
      job('spec-writer', { externalId: 'issue_2', usage: [session()] }),
      job('spec-writer', { productSlug: 'other', usage: [session()] }),
    ];
    expect(buildUsageReport(jobs, q).sessions).toBe(1);
    expect(buildUsageReport(jobs, { productSlug: 'p' }).sessions).toBe(2);
  });
});

describe('buildUsageReport — legacy, interrupted and capture gaps', () => {
  it('counts legacy jobs (no usage field) as not instrumented and never fails on them', () => {
    const legacy = job('implementer', { usage: undefined, usageCaptureFailures: undefined });
    const fresh = job('implementer', { usage: [] });
    const r = buildUsageReport([legacy, fresh], q);
    expect(r.jobsNotInstrumented).toBe(1);
    expect(r.sessions).toBe(0);
  });

  it('legacy cyclesCompleted still counts toward reviewRounds', () => {
    const legacy = job('reviewer-fanout', {
      usage: undefined,
      result: {
        specialistId: 'reviewer-fanout',
        status: 'done',
        costUsd: 0,
        durationMs: 1,
        cyclesCompleted: 2,
      },
    });
    expect(buildUsageReport([legacy], q).reviewRounds).toBe(2);
  });

  it('counts orphaned jobs as interrupted and keeps their finished sessions', () => {
    const orphan = job('implementer', {
      status: 'error',
      error: 'orphaned: server restarted during execution',
      usage: [session({ stage: 'code' })],
    });
    const plainError = job('implementer', { status: 'error', error: 'boom' });
    const r = buildUsageReport([orphan, plainError], q);
    expect(r.jobsInterrupted).toBe(1);
    expect(r.sessions).toBe(1);
  });

  it('flags jobs with capture gaps, including one recorded and one failed session', () => {
    const gap = job('reviewer-fanout', { usage: [session()], usageCaptureFailures: 1 });
    const r = buildUsageReport([gap, job('reviewer-fanout')], q);
    expect(r.jobsWithCaptureGaps).toBe(1);
    expect(r.sessions).toBe(1);
  });

  it('a new job with usage [] is not legacy', () => {
    expect(buildUsageReport([job('implementer', { usage: [] })], q).jobsNotInstrumented).toBe(0);
  });

  it('tolerates malformed persisted records', () => {
    const bad = job('implementer', {
      usage: [
        null,
        'x',
        { startedAt: 'nope', tokens: 'bad', costUsd: 'free', durationMs: -5 },
      ] as unknown as UsageRecord[],
    });
    const r = buildUsageReport([bad], q);
    expect(r.sessions).toBe(1);
    expect(r.durationMs).toBe(0);
    expect(r.costUsd.sessionsUnknown).toBe(1);
  });
});

describe('buildUsageReport — period and groupBy', () => {
  const from = new Date('2026-11-05T00:00:00.000Z');
  const to = new Date('2026-11-10T00:00:00.000Z');

  it('filters sessions by their own startedAt and jobs by the job startedAt (straddling job)', () => {
    const straddling = job('reviewer-fanout', {
      startedAt: '2026-11-09T23:00:00.000Z',
      usage: [
        session({ startedAt: '2026-11-09T23:30:00.000Z' }),
        session({ startedAt: '2026-11-10T00:30:00.000Z' }),
      ],
      result: {
        specialistId: 'reviewer-fanout',
        status: 'done',
        costUsd: 0,
        durationMs: 1,
        cyclesCompleted: 3,
      },
    });
    const inside = buildUsageReport([straddling], { ...q, from, to });
    expect(inside.sessions).toBe(1);
    expect(inside.reviewRounds).toBe(3);

    const after = buildUsageReport([straddling], {
      ...q,
      from: to,
      to: new Date('2026-11-20T00:00:00.000Z'),
    });
    expect(after.sessions).toBe(1);
    expect(after.reviewRounds).toBe(0);
  });

  it('from is inclusive and to is exclusive', () => {
    const jobs = [
      job('spec-writer', {
        usage: [
          session({ startedAt: from.toISOString() }),
          session({ startedAt: to.toISOString() }),
        ],
      }),
    ];
    expect(buildUsageReport(jobs, { ...q, from, to }).sessions).toBe(1);
  });

  it('groupBy=item, stage and month', () => {
    const jobs = [
      job('spec-writer', {
        externalId: 'issue_1',
        usage: [session({ stage: 'spec', startedAt: '2026-10-31T23:59:59.000Z' })],
      }),
      job('implementer', {
        externalId: 'issue_2',
        usage: [session({ stage: 'code', startedAt: '2026-11-01T00:00:00.000Z' })],
      }),
    ];
    const byItem = buildUsageReport(jobs, { productSlug: 'p', groupBy: 'item' });
    expect(byItem.groups?.map((g) => [g.key, g.sessions])).toEqual([
      ['issue_1', 1],
      ['issue_2', 1],
    ]);

    const byStage = buildUsageReport(jobs, { productSlug: 'p', groupBy: 'stage' });
    expect(byStage.groups?.map((g) => g.key)).toEqual(['code', 'spec']);

    const byMonth = buildUsageReport(jobs, { productSlug: 'p', groupBy: 'month' });
    expect(byMonth.groups?.map((g) => [g.key, g.sessions])).toEqual([
      ['2026-10', 1],
      ['2026-11', 1],
    ]);
    expect(byMonth.groupBy).toBe('month');
  });

  it('has no groups without groupBy', () => {
    expect(buildUsageReport([], { productSlug: 'p' }).groups).toBeUndefined();
  });
});

describe('formatUsageTable', () => {
  it('prints the aggregate with denominators and the external-review note', () => {
    const jobs = [
      job('implementer', { usage: [session({ stage: 'code' }), codexSession({ stage: 'code' })] }),
    ];
    const out = formatUsageTable(buildUsageReport(jobs, { ...q }));
    expect(out).toContain('usage: p/issue_1');
    expect(out).toContain('stage:code');
    expect(out).toContain('0.5000 (1/1)');
    expect(out).toContain('external-review: not measured');
  });
});
