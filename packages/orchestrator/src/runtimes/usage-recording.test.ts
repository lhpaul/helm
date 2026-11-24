import { describe, expect, it, vi } from 'vitest';
import { stageForJobSpecialist } from '../dispatcher.js';
import type { AgentResult, AgentSession, IAgentRuntime, SpawnParams } from '../runtime.js';
import { unknownUsage } from '../runtime.js';
import { UsageRecordingRuntime } from './usage-recording.js';
import type { UsageRecord } from './usage-recording.js';

const params = (specialistId: string, over: Partial<SpawnParams> = {}): SpawnParams => ({
  specialistId,
  prompt: 'p',
  workdir: '/w',
  productSlug: 'prod',
  externalId: 'issue_1',
  ...over,
});

function fakeRuntime(results: Array<AgentResult | Error>): IAgentRuntime {
  let i = 0;
  return {
    async spawn(): Promise<AgentSession> {
      const r = results[i++] ?? results[results.length - 1]!;
      return {
        id: `s${i}`,
        status: 'running',
        onMessage: () => {},
        send: async () => {},
        cancel: async () => {},
        wait: () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)),
      };
    },
  };
}

const reported: AgentResult = {
  status: 'done',
  finalOutput: 'SECRET-OUTPUT',
  totalCostUsd: 0.5,
  durationMs: 1,
  usage: {
    tokens: { input: 10, output: 5, cacheRead: 3, cacheCreation: 2, reasoning: null },
    costUsd: 0.5,
    costSource: 'reported',
    model: 'claude-x',
  },
};

function build(runtime: IAgentRuntime, sink: (r: UsageRecord) => Promise<void>) {
  const onCaptureFailure = vi.fn().mockResolvedValue(undefined);
  const rec = new UsageRecordingRuntime(runtime, {
    jobId: 'job-1',
    stage: 'review',
    runtime: 'claude-code',
    onUsage: sink,
    onCaptureFailure,
  });
  return { rec, onCaptureFailure };
}

describe('UsageRecordingRuntime', () => {
  it('emits one record per session with item, job, specialist, stage, tokens and cost', async () => {
    const records: UsageRecord[] = [];
    const { rec } = build(fakeRuntime([reported]), async (r) => void records.push(r));

    const s = await rec.spawn(params('reviewer-security', { model: 'hint' }));
    await s.wait();
    await rec.flush();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      productSlug: 'prod',
      externalId: 'issue_1',
      jobId: 'job-1',
      specialistId: 'reviewer-security',
      stage: 'review',
      runtime: 'claude-code',
      model: 'claude-x',
      status: 'done',
      tokens: { input: 10, output: 5, cacheRead: 3, cacheCreation: 2, reasoning: null },
      costUsd: 0.5,
      costSource: 'reported',
    });
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(records[0]!.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(records[0]!.startedAt),
    );
  });

  it('falls back to the model hint, then null', async () => {
    const records: UsageRecord[] = [];
    const noModel: AgentResult = { ...reported, usage: { ...reported.usage!, model: undefined } };
    const { rec } = build(fakeRuntime([noModel]), async (r) => void records.push(r));
    await (await rec.spawn(params('a', { model: 'hint' }))).wait();
    await (await rec.spawn(params('b'))).wait();
    await rec.flush();
    expect(records.map((r) => r.model)).toEqual(['hint', null]);
  });

  it('records one entry per session (fan-out, adjudicator, remediator) under the job stage', async () => {
    const records: UsageRecord[] = [];
    const { rec } = build(fakeRuntime([reported]), async (r) => void records.push(r));
    const ids = ['reviewer-a', 'reviewer-b', 'reviewer-c', 'adjudicator', 'remediator'];
    await Promise.all(ids.map(async (id) => (await rec.spawn(params(id))).wait()));
    await rec.flush();
    expect(records.map((r) => r.specialistId).sort()).toEqual([...ids].sort());
    expect(new Set(records.map((r) => r.stage))).toEqual(new Set(['review']));
  });

  it.each([
    ['error', { ...reported, status: 'error' as const, usage: unknownUsage() }],
    ['cancelled', { ...reported, status: 'cancelled' as const, usage: unknownUsage() }],
    [
      'legacy runtime without usage',
      { status: 'done' as const, finalOutput: '', totalCostUsd: 0, durationMs: 1 },
    ],
  ])('records null tokens and cost for %s sessions', async (_n, result) => {
    const records: UsageRecord[] = [];
    const { rec } = build(fakeRuntime([result]), async (r) => void records.push(r));
    await (await rec.spawn(params('x'))).wait();
    await rec.flush();
    expect(records[0]!.status).toBe(result.status);
    expect(records[0]!.tokens).toEqual(unknownUsage().tokens);
    expect(records[0]!.costUsd).toBeNull();
    expect(records[0]!.costSource).toBe('unknown');
  });

  it('records an error session with unknown usage when wait() rejects', async () => {
    const records: UsageRecord[] = [];
    const { rec } = build(fakeRuntime([new Error('boom')]), async (r) => void records.push(r));
    const s = await rec.spawn(params('x'));
    await expect(s.wait()).rejects.toThrow('boom');
    await rec.flush();
    expect(records[0]).toMatchObject({ status: 'error', costUsd: null, costSource: 'unknown' });
  });

  it('does not alter the session result', async () => {
    const { rec } = build(fakeRuntime([reported]), async () => {});
    const result = await (await rec.spawn(params('x'))).wait();
    expect(result).toBe(reported);
  });

  it('a failing sink never fails the session and bumps the capture-failure counter', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rec, onCaptureFailure } = build(fakeRuntime([reported]), async () => {
      throw new Error('disk full: /secret/path');
    });

    const s = await rec.spawn(params('x'));
    await expect(s.wait()).resolves.toBe(reported);
    await expect(rec.flush()).resolves.toBeUndefined();

    expect(onCaptureFailure).toHaveBeenCalledTimes(1);
    // Metadata only: no error message in the log.
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('/secret/path');
    errSpy.mockRestore();
  });

  it('double failure (sink and counter both fail) still leaves the session untouched', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onCaptureFailure = vi.fn().mockRejectedValue(new Error('unwritable'));
    const rec = new UsageRecordingRuntime(fakeRuntime([reported]), {
      jobId: 'job-1',
      stage: 'code',
      runtime: 'codex',
      onUsage: async () => {
        throw new Error('unwritable');
      },
      onCaptureFailure,
    });
    const s = await rec.spawn(params('x'));
    await expect(s.wait()).resolves.toBe(reported);
    await expect(rec.flush()).resolves.toBeUndefined();
    expect(onCaptureFailure).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('persisted records contain only allow-listed fields — no prompt, output, workdir or env values', async () => {
    const records: UsageRecord[] = [];
    const { rec } = build(
      fakeRuntime([{ ...reported, finalOutput: 'OUTPUT-SENTINEL' }]),
      async (r) => void records.push(r),
    );
    await (
      await rec.spawn({
        ...params('x'),
        prompt: 'PROMPT-SENTINEL',
        workdir: '/WORKDIR-SENTINEL',
        env: { TOKEN: 'ENV-SENTINEL' },
      })
    ).wait();
    await rec.flush();

    expect(Object.keys(records[0]!).sort()).toEqual(
      [
        'costSource',
        'costUsd',
        'durationMs',
        'endedAt',
        'externalId',
        'jobId',
        'model',
        'productSlug',
        'runtime',
        'specialistId',
        'stage',
        'startedAt',
        'status',
        'tokens',
      ].sort(),
    );
    const json = JSON.stringify(records[0]);
    for (const s of ['PROMPT-SENTINEL', 'OUTPUT-SENTINEL', 'WORKDIR-SENTINEL', 'ENV-SENTINEL']) {
      expect(json).not.toContain(s);
    }
  });
});

describe('stageForJobSpecialist', () => {
  it.each([
    ['spec-writer', 'spec'],
    ['spec-draft-reviewer', 'spec'],
    ['spec-remediator', 'spec'],
    ['plan-writer', 'plan'],
    ['plan-draft-reviewer', 'plan'],
    ['plan-remediator', 'plan'],
    ['implementer', 'code'],
    ['reviewer-fanout', 'review'],
  ])('%s → %s', (id, stage) => {
    expect(stageForJobSpecialist(id)).toBe(stage);
  });

  it('is undefined for ids that run no sessions (including prototype keys)', () => {
    expect(stageForJobSpecialist('none')).toBeUndefined();
    expect(stageForJobSpecialist('constructor')).toBeUndefined();
  });
});
