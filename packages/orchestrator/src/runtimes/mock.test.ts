import { mkdir, rm, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgentRuntime } from './mock.js';
import type { AgentMessage, SpawnParams } from '../runtime.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeParams = (workdir: string): SpawnParams => ({
  specialistId: 'spec-writer',
  prompt: 'write a spec',
  workdir,
  productSlug: 'test-product',
  externalId: 'issue_1',
  model: 'claude-sonnet-4-6',
});

const msg = (content: string, costUsd = 0): AgentMessage => ({
  role: 'agent',
  content,
  costUsd,
  timestamp: new Date().toISOString(),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MockAgentRuntime', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = join(tmpdir(), `mock-runtime-${randomUUID()}`);
    await mkdir(workdir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('emits scripted messages via onMessage handler', async () => {
    const runtime = new MockAgentRuntime({
      messages: [msg('hello'), msg('world')],
    });

    const session = await runtime.spawn(makeParams(workdir));
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    expect(received).toHaveLength(2);
    expect(received[0]?.content).toBe('hello');
    expect(received[1]?.content).toBe('world');
  });

  it('wait() resolves with done status and accumulated costUsd', async () => {
    const runtime = new MockAgentRuntime({
      messages: [msg('a', 0.01), msg('b', 0.02)],
    });

    const session = await runtime.spawn(makeParams(workdir));
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.totalCostUsd).toBeCloseTo(0.03);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses last message content as finalOutput by default', async () => {
    const runtime = new MockAgentRuntime({
      messages: [msg('first'), msg('last')],
    });

    const session = await runtime.spawn(makeParams(workdir));
    const result = await session.wait();

    expect(result.finalOutput).toBe('last');
  });

  it('uses finalOutput override when provided', async () => {
    const runtime = new MockAgentRuntime({
      messages: [msg('raw output')],
      finalOutput: 'override output',
    });

    const session = await runtime.spawn(makeParams(workdir));
    const result = await session.wait();

    expect(result.finalOutput).toBe('override output');
  });

  it('runs sideEffects before resolving', async () => {
    const specFile = join(workdir, 'specs', 'issue_1.md');

    const runtime = new MockAgentRuntime({
      messages: [msg('done')],
      sideEffects: async (dir) => {
        await mkdir(join(dir, 'specs'), { recursive: true });
        await writeFile(join(dir, 'specs', 'issue_1.md'), '# Spec');
      },
    });

    const session = await runtime.spawn(makeParams(workdir));
    await session.wait();

    // File must exist after wait() resolves
    await expect(access(specFile)).resolves.toBeUndefined();
  });

  it('cancel() resolves with cancelled status', async () => {
    const runtime = new MockAgentRuntime({
      messages: [
        { role: 'agent', content: 'slow', delayMs: 2000, timestamp: new Date().toISOString() },
      ],
    });

    const session = await runtime.spawn(makeParams(workdir));
    await session.cancel();
    const result = await session.wait();

    expect(result.status).toBe('cancelled');
    expect(result.totalCostUsd).toBe(0);
  });

  it('send() emits a system message with the instruction', async () => {
    const runtime = new MockAgentRuntime({ messages: [msg('ok')] });
    const session = await runtime.spawn(makeParams(workdir));

    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));

    await session.send('focus on security');
    await session.wait();

    const systemMsg = received.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain('focus on security');
  });

  it('concurrent wait() calls both resolve with the same terminal status', async () => {
    const runtime = new MockAgentRuntime({ messages: [msg('done')] });
    const session = await runtime.spawn(makeParams(workdir));

    const [r1, r2] = await Promise.all([session.wait(), session.wait()]);

    expect(r1.status).toBe('done');
    expect(r2.status).toBe('done');
  });

  it('resolves with error status when script outcome is error', async () => {
    const runtime = new MockAgentRuntime({
      messages: [msg('failed')],
      outcome: 'error',
    });

    const session = await runtime.spawn(makeParams(workdir));
    const result = await session.wait();

    expect(result.status).toBe('error');
  });
});
