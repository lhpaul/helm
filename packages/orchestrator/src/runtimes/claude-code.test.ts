import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRuntime } from './claude-code.js';
import type { SubprocessLike } from './claude-code.js';
import type { AgentMessage, SpawnParams } from '../runtime.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dirname, '__fixtures__', 'claude-code');

function loadFixture(name: string): string[] {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

/**
 * Creates a fake SubprocessLike whose stdout emits the given lines as JSONL.
 * Lines are enqueued as microtasks so onMessage handlers registered after
 * spawn() can still capture the first message.
 */
function makeFakeProcess(lines: string[]): SubprocessLike {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });

  // Schedule emission as microtasks so the session can be fully set up first.
  void Promise.resolve().then(() => {
    for (const line of lines) {
      ctrl.enqueue(encoder.encode(line + '\n'));
    }
    ctrl.close();
    exitResolve(0);
  });

  return {
    stdout,
    kill() {
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
      exitResolve(1);
    },
    get exited() {
      return exited;
    },
  };
}

const makeParams = (workdir = '/tmp/test-workdir'): SpawnParams => ({
  specialistId: 'spec-writer',
  prompt: 'Write a spec.',
  workdir,
  productSlug: 'test-product',
  externalId: 'issue_1',
  model: 'claude-sonnet-4-6',
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ClaudeCodeRuntime', () => {
  it('resolves wait() with status done and correct cost from write-success fixture', async () => {
    const lines = loadFixture('write-success.jsonl');
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.totalCostUsd).toBeCloseTo(0.048494550000000004, 10);
    expect(result.durationMs).toBe(5746);
    expect(result.finalOutput).toContain('hello.txt');
  });

  it('resolves wait() with status error for permission-denied fixture (subtype:success is misleading)', async () => {
    // CRITICAL: The permission-denied fixture has subtype:'success' and is_error:false
    // in the result line — identical to the success case. Only permission_denials
    // distinguishes them. Verify the runtime reads permission_denials correctly.
    const lines = loadFixture('permission-denied.jsonl');
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    // Cost is still reported even on permission denial
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('emits text assistant messages via onMessage handler', async () => {
    const lines = loadFixture('write-success.jsonl');
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    const textMsgs = received.filter((m) => m.role === 'agent');
    expect(textMsgs.length).toBeGreaterThan(0);
    expect(textMsgs[0]?.content).toBeTruthy();
  });

  it('emits tool_use messages as role:tool', async () => {
    const lines = loadFixture('write-success.jsonl');
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    const toolMsgs = received.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(toolMsgs[0]?.content).toContain('Write');
  });

  it('handles partial-line buffering — splits a fixture across two unaligned chunks', async () => {
    const lines = loadFixture('write-success.jsonl');
    const combined = lines.join('\n') + '\n';
    // Split deliberately at a non-newline position
    const splitAt = Math.floor(combined.length * 0.4);
    const chunk1 = combined.slice(0, splitAt);
    const chunk2 = combined.slice(splitAt);

    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let exitResolve!: (code: number) => void;

    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const exited = new Promise<number>((r) => {
      exitResolve = r;
    });

    void Promise.resolve().then(() => {
      ctrl.enqueue(encoder.encode(chunk1));
      ctrl.enqueue(encoder.encode(chunk2));
      ctrl.close();
      exitResolve(0);
    });

    const proc: SubprocessLike = {
      stdout,
      kill() {
        try {
          ctrl.close();
        } catch {
          /* */
        }
        exitResolve(1);
      },
      get exited() {
        return exited;
      },
    };

    const runtime = new ClaudeCodeRuntime(() => proc);
    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    // If buffering works, the result line is fully parsed → status done
    expect(result.status).toBe('done');
    expect(result.totalCostUsd).toBeCloseTo(0.048494550000000004, 10);
  });

  it('skips malformed JSON lines without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines = loadFixture('write-success.jsonl');
    // Inject garbage between lines 5 and 6
    const withJunk = [...lines.slice(0, 5), '!!not-json!!', ...lines.slice(5)];

    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(withJunk));
    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done'); // session still completes
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[claude-code] Malformed JSON line'),
      expect.stringContaining('!!not-json!!'),
    );
    consoleSpy.mockRestore();
  });

  it('cancel() resolves wait() with cancelled status', async () => {
    // Use a slow stream — lines only available after a delay
    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let exitResolve!: (code: number) => void;

    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const exited = new Promise<number>((r) => {
      exitResolve = r;
    });

    // Never enqueue anything — the session blocks on reader.read()
    const proc: SubprocessLike = {
      stdout,
      kill() {
        try {
          ctrl.close();
        } catch {
          /* */
        }
        exitResolve(1);
      },
      get exited() {
        return exited;
      },
    };

    const runtime = new ClaudeCodeRuntime(() => proc);
    const session = await runtime.spawn(makeParams());
    // Cancel immediately before any data arrives
    await session.cancel();
    const result = await session.wait();

    expect(result.status).toBe('cancelled');

    // Prevent unused variable warning
    void encoder;
  });

  it('resolves wait() with error when process exits without emitting a result line', async () => {
    // Emit only system/hook lines — no result
    const noResultLines = loadFixture('write-success.jsonl').slice(0, 4);
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(noResultLines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
  });

  it('spawn() passes --model flag when params.model is set', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawnFn = (args: string[], cwd: string): SubprocessLike => {
      void cwd;
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('write-success.jsonl'));
    };

    const runtime = new ClaudeCodeRuntime(fakeSpawnFn);
    const session = await runtime.spawn(makeParams());
    await session.wait();

    const args = capturedArgs[0] ?? [];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('claude-sonnet-4-6');
  });
});
