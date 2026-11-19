import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '@helm/orchestrator';
import { app } from '../app.js';
import { withOperatorToken } from '../test-support/operator-token.js';
import { _resetForTests, getJobStore } from '../services/index.js';
import type { UsageReport } from '../services/usage.js';

const report = async (res: Response) => (await res.json()) as UsageReport;
const errorOf = async (res: Response) => ((await res.json()) as { error: unknown }).error;

const authed = withOperatorToken(app);

let dataDir: string;
let saved: string | undefined;

beforeEach(async () => {
  _resetForTests();
  dataDir = join(tmpdir(), `usage-route-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  saved = process.env.HELM_DATA_DIR;
  process.env.HELM_DATA_DIR = dataDir;
});

afterEach(async () => {
  _resetForTests();
  await rm(dataDir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = saved;
});

const rec = (startedAt: string, over: Partial<UsageRecord> = {}): UsageRecord => ({
  productSlug: 'prod',
  externalId: 'issue_1',
  jobId: 'j',
  specialistId: 'x',
  stage: 'code',
  runtime: 'codex',
  model: null,
  startedAt,
  endedAt: startedAt,
  durationMs: 1000,
  status: 'done',
  tokens: { input: 10, output: 2, cacheRead: 4, cacheCreation: null, reasoning: 1 },
  costUsd: null,
  costSource: 'unknown',
  ...over,
});

async function seed() {
  const store = await getJobStore();
  const j1 = await store.createJob({
    productSlug: 'prod',
    externalId: 'issue_1',
    specialistId: 'implementer',
  });
  await store.appendUsage(j1.jobId, rec('2026-11-01T10:00:00.000Z'));
  await store.updateJob(j1.jobId, { status: 'done', startedAt: '2026-11-01T09:00:00.000Z' });
  const j2 = await store.createJob({
    productSlug: 'prod',
    externalId: 'issue_2',
    specialistId: 'spec-writer',
  });
  await store.appendUsage(
    j2.jobId,
    rec('2026-12-01T10:00:00.000Z', { externalId: 'issue_2', stage: 'spec' }),
  );
  await store.updateJob(j2.jobId, { status: 'done', startedAt: '2026-12-01T09:00:00.000Z' });
}

describe('GET /api/products/:slug/items/:externalId/usage', () => {
  it('returns 401 without the operator token', async () => {
    const res = await app.request('/api/products/prod/items/issue_1/usage');
    expect(res.status).toBe(401);
  });

  it('returns the item aggregate with byStage', async () => {
    await seed();
    const res = await authed.request('/api/products/prod/items/issue_1/usage');
    expect(res.status).toBe(200);
    const body = await report(res);
    expect(body.sessions).toBe(1);
    expect(body.costUsd).toEqual({ total: 0, sessionsWithCost: 0, sessionsUnknown: 1 });
    expect(body.byStage.code?.sessions).toBe(1);
    expect(body.scope.externalId).toBe('issue_1');
    expect(body.notes).toContain('external-review: not measured');
  });

  it('returns an empty aggregate for an item without jobs', async () => {
    const res = await authed.request('/api/products/prod/items/issue_9/usage');
    expect(res.status).toBe(200);
    expect((await report(res)).sessions).toBe(0);
  });

  it.each([
    ['/api/products/Bad_Slug/items/issue_1/usage'],
    ['/api/products/prod/items/..%2Fx/usage'],
    ['/api/products/prod/items/issue_1/usage?from=2026-01-01'],
  ])('rejects invalid input with 400: %s', async (url) => {
    const res = await authed.request(url);
    expect(res.status).toBe(400);
    expect(typeof (await errorOf(res))).toBe('string');
  });
});

describe('GET /api/products/:slug/usage', () => {
  it('returns 401 without the operator token', async () => {
    const res = await app.request('/api/products/prod/usage');
    expect(res.status).toBe(401);
  });

  it('aggregates all time by default', async () => {
    await seed();
    const res = await authed.request('/api/products/prod/usage');
    expect(res.status).toBe(200);
    const body = await report(res);
    expect(body.sessions).toBe(2);
    expect(body.groups).toBeUndefined();
  });

  it('filters by period (from inclusive, to exclusive) and groups', async () => {
    await seed();
    const res = await authed.request(
      '/api/products/prod/usage?from=2026-11-01&to=2026-12-01&groupBy=item',
    );
    expect(res.status).toBe(200);
    const body = await report(res);
    expect(body.sessions).toBe(1);
    expect(body.scope.from).toBe('2026-11-01T00:00:00.000Z');
    expect(body.groups?.map((g) => g.key)).toEqual(['issue_1']);
  });

  it('accepts ISO date-times', async () => {
    await seed();
    const res = await authed.request(
      `/api/products/prod/usage?from=${encodeURIComponent('2026-11-01T10:00:00Z')}&groupBy=month`,
    );
    expect(res.status).toBe(200);
    expect((await report(res)).groups).toHaveLength(2);
  });

  it.each([
    ['from=yesterday'],
    ['from=2026-02-31'],
    ['to=2026-13-01'],
    ['from='],
    ['from=2026-12-01&to=2026-11-01'],
    ['from=2026-11-01&to=2026-11-01'],
    ['groupBy=year'],
    ['groupBy='],
    ['limit=5'],
  ])('rejects %s with 400', async (qs) => {
    const res = await authed.request(`/api/products/prod/usage?${qs}`);
    expect(res.status).toBe(400);
    expect(typeof (await errorOf(res))).toBe('string');
  });

  it('rejects an invalid slug with 400', async () => {
    expect((await authed.request('/api/products/BAD/usage')).status).toBe(400);
  });
});
