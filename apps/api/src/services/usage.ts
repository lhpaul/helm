import { stageForJobSpecialist } from '@helm/orchestrator';
import type { UsageRecord, UsageStage } from '@helm/orchestrator';
import type { Job } from './job-store.js';

/**
 * Usage aggregation (#151, spec `issue_151`). Pure functions over job files.
 *
 * Rules that keep totals honest:
 * - Sums cover KNOWN values only, and every figure comes with its denominator
 *   (`sessionsReported`, `sessionsWithCost`/`sessionsUnknown`).
 * - `costUsd` is read ONLY from `UsageRecord.costUsd`/`costSource`; the legacy
 *   `DispatchResult.costUsd` / `AgentResult.totalCostUsd` (0 when unknown) are
 *   never read.
 * - Session-level data filters on the session's `startedAt`; job-level data
 *   (review rounds, interrupted / not-instrumented / capture-gap counts)
 *   filters on the job's `startedAt`.
 */

export const GROUP_BY_VALUES = ['item', 'stage', 'month'] as const;
export type UsageGroupBy = (typeof GROUP_BY_VALUES)[number];

export const USAGE_STAGES: readonly UsageStage[] = ['spec', 'plan', 'code', 'review'];

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreation', 'reasoning'] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];

export const EXTERNAL_REVIEW_NOTE = 'external-review: not measured';

export interface TokenTotal {
  total: number;
  sessionsReported: number;
}

export interface UsageCore {
  sessions: number;
  durationMs: number;
  tokens: Record<TokenKey, TokenTotal>;
  costUsd: { total: number; sessionsWithCost: number; sessionsUnknown: number };
  reviewRounds: number;
  jobsInterrupted: number;
  jobsNotInstrumented: number;
  jobsWithCaptureGaps: number;
}

export interface UsageAggregate extends UsageCore {
  byStage: Partial<Record<UsageStage, UsageCore>>;
}

export interface UsageScope {
  productSlug: string;
  externalId: string | null;
  from: string | null;
  to: string | null;
}

export interface UsageReport extends UsageAggregate {
  scope: UsageScope;
  notes: string[];
  groupBy?: UsageGroupBy;
  groups?: Array<{ key: string } & UsageCore>;
}

export interface UsageQuery {
  productSlug: string;
  externalId?: string;
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
  groupBy?: UsageGroupBy;
}

// ── Accumulator ───────────────────────────────────────────────────────────────

function emptyCore(): UsageCore {
  return {
    sessions: 0,
    durationMs: 0,
    tokens: {
      input: { total: 0, sessionsReported: 0 },
      output: { total: 0, sessionsReported: 0 },
      cacheRead: { total: 0, sessionsReported: 0 },
      cacheCreation: { total: 0, sessionsReported: 0 },
      reasoning: { total: 0, sessionsReported: 0 },
    },
    costUsd: { total: 0, sessionsWithCost: 0, sessionsUnknown: 0 },
    reviewRounds: 0,
    jobsInterrupted: 0,
    jobsNotInstrumented: 0,
    jobsWithCaptureGaps: 0,
  };
}

/** A finite, non-negative number or `null`; tolerates malformed persisted data. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function addSession(core: UsageCore, s: UsageRecord): void {
  core.sessions += 1;
  core.durationMs += num(s.durationMs) ?? 0;
  const tokens = (s.tokens ?? {}) as Partial<Record<TokenKey, unknown>>;
  for (const key of TOKEN_KEYS) {
    const v = num(tokens[key]);
    if (v !== null) {
      core.tokens[key].total += v;
      core.tokens[key].sessionsReported += 1;
    }
  }
  const cost = num(s.costUsd);
  if (cost !== null && s.costSource === 'reported') {
    core.costUsd.total += cost;
    core.costUsd.sessionsWithCost += 1;
  } else {
    core.costUsd.sessionsUnknown += 1;
  }
}

function isInterrupted(job: Job): boolean {
  return (
    job.status === 'error' && typeof job.error === 'string' && job.error.startsWith('orphaned')
  );
}

function addJob(core: UsageCore, job: Job, isReviewJob: boolean): void {
  if (isReviewJob) core.reviewRounds += num(job.result?.cyclesCompleted) ?? 0;
  if (isInterrupted(job)) core.jobsInterrupted += 1;
  if (!Array.isArray(job.usage)) core.jobsNotInstrumented += 1;
  if ((num(job.usageCaptureFailures) ?? 0) > 0) core.jobsWithCaptureGaps += 1;
}

function monthOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unknown' : new Date(t).toISOString().slice(0, 7);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the usage report from jobs. `jobs` may contain other products/items;
 * the query scopes them. Never throws on legacy or malformed job records.
 */
export function buildUsageReport(jobs: readonly Job[], query: UsageQuery): UsageReport {
  const fromMs = query.from?.getTime();
  const toMs = query.to?.getTime();
  const inPeriod = (iso: unknown): boolean => {
    if (fromMs === undefined && toMs === undefined) return true;
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (Number.isNaN(t)) return false;
    return (fromMs === undefined || t >= fromMs) && (toMs === undefined || t < toMs);
  };

  const total = emptyCore();
  const byStage = new Map<UsageStage, UsageCore>();
  const groups = new Map<string, UsageCore>();

  const stageCore = (stage: UsageStage): UsageCore => {
    let c = byStage.get(stage);
    if (!c) byStage.set(stage, (c = emptyCore()));
    return c;
  };
  const groupCore = (key: string): UsageCore => {
    let c = groups.get(key);
    if (!c) groups.set(key, (c = emptyCore()));
    return c;
  };
  const groupKey = (externalId: string, stage: UsageStage | undefined, startedAt: string) => {
    switch (query.groupBy) {
      case 'item':
        return externalId;
      case 'stage':
        return stage ?? 'unknown';
      case 'month':
        return monthOf(startedAt);
      default:
        return undefined;
    }
  };

  for (const job of jobs) {
    if (job.productSlug !== query.productSlug) continue;
    if (query.externalId !== undefined && job.externalId !== query.externalId) continue;

    const stage = stageForJobSpecialist(job.specialistId);
    const isReviewJob = stage === 'review';

    if (inPeriod(job.startedAt)) {
      const key = groupKey(job.externalId, stage, job.startedAt);
      addJob(total, job, isReviewJob);
      if (stage) addJob(stageCore(stage), job, isReviewJob);
      if (key !== undefined) addJob(groupCore(key), job, isReviewJob);
    }

    if (!Array.isArray(job.usage)) continue;
    for (const session of job.usage) {
      if (!session || typeof session !== 'object') continue;
      if (!inPeriod(session.startedAt)) continue;
      const sessionStage = USAGE_STAGES.includes(session.stage) ? session.stage : stage;
      const key = groupKey(job.externalId, sessionStage, String(session.startedAt));
      addSession(total, session);
      if (sessionStage) addSession(stageCore(sessionStage), session);
      if (key !== undefined) addSession(groupCore(key), session);
    }
  }

  const stages: Partial<Record<UsageStage, UsageCore>> = {};
  for (const s of USAGE_STAGES) {
    const c = byStage.get(s);
    if (c) stages[s] = c;
  }

  const report: UsageReport = {
    scope: {
      productSlug: query.productSlug,
      externalId: query.externalId ?? null,
      from: query.from?.toISOString() ?? null,
      to: query.to?.toISOString() ?? null,
    },
    ...total,
    byStage: stages,
    notes: [EXTERNAL_REVIEW_NOTE],
  };
  if (query.groupBy) {
    report.groupBy = query.groupBy;
    report.groups = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, core]) => ({ key, ...core }));
  }
  return report;
}

/** Operator-facing table: one aggregate, same numbers as the API. */
export function formatUsageTable(report: UsageReport): string {
  const rows: Array<[string, UsageCore]> = [['total', report]];
  for (const stage of USAGE_STAGES) {
    const c = report.byStage[stage];
    if (c) rows.push([`stage:${stage}`, c]);
  }
  for (const g of report.groups ?? []) rows.push([`${report.groupBy}:${g.key}`, g]);

  const fmt = (t: TokenTotal): string => `${t.total} (${t.sessionsReported})`;
  const header = [
    'scope',
    'sessions',
    'duration_s',
    'input (n)',
    'output (n)',
    'cache_read (n)',
    'cache_create (n)',
    'reasoning (n)',
    'cost_usd (known/unknown)',
    'review_rounds',
    'interrupted',
    'not_instrumented',
    'capture_gaps',
  ];
  const body = rows.map(([name, c]) => [
    name,
    String(c.sessions),
    (c.durationMs / 1000).toFixed(1),
    fmt(c.tokens.input),
    fmt(c.tokens.output),
    fmt(c.tokens.cacheRead),
    fmt(c.tokens.cacheCreation),
    fmt(c.tokens.reasoning),
    `${c.costUsd.total.toFixed(4)} (${c.costUsd.sessionsWithCost}/${c.costUsd.sessionsUnknown})`,
    String(c.reviewRounds),
    String(c.jobsInterrupted),
    String(c.jobsNotInstrumented),
    String(c.jobsWithCaptureGaps),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const scope = report.scope;
  const title =
    `usage: ${scope.productSlug}${scope.externalId ? `/${scope.externalId}` : ''}` +
    ` [${scope.from ?? '-∞'} .. ${scope.to ?? '+∞'})`;
  return [
    title,
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
    '',
    '(n) = sessions that reported the figure; cost_usd sums known values only. ' +
      `Note: ${EXTERNAL_REVIEW_NOTE}.`,
  ].join('\n');
}
