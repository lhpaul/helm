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
 * Creates a fake SubprocessLike whose stdout emits the given JSONL lines and
 * whose stderr emits optional diagnostic text. Lines are enqueued as
 * microtasks so onMessage handlers registered after spawn() capture all events.
 *
 * Returns the process plus a `wasKilled` getter so tests can assert kill().
 */
function makeFakeProcess(
  lines: string[],
  options: { stderrContent?: string } = {},
): SubprocessLike & { readonly wasKilled: boolean } {
  const encoder = new TextEncoder();
  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;
  let killed = false;

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutCtrl = c;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrCtrl = c;
    },
  });
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });

  const closeAll = (code: number) => {
    try {
      stdoutCtrl.close();
    } catch {
      /* already closed */
    }
    try {
      stderrCtrl.close();
    } catch {
      /* already closed */
    }
    exitResolve(code);
  };

  // Schedule emission as microtasks so the session can register handlers first.
  void Promise.resolve().then(() => {
    for (const line of lines) {
      stdoutCtrl.enqueue(encoder.encode(line + '\n'));
    }
    if (options.stderrContent) {
      stderrCtrl.enqueue(encoder.encode(options.stderrContent));
    }
    closeAll(0);
  });

  return {
    stdout,
    stderr,
    kill() {
      killed = true;
      closeAll(1);
    },
    get exited() {
      return exited;
    },
    get wasKilled() {
      return killed;
    },
  };
}

/**
 * Creates a fake process whose stdout never closes — simulates a hung process.
 * Useful for testing the timeout path.
 */
function makeHangingProcess(): SubprocessLike & { readonly wasKilled: boolean } {
  let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;
  let killed = false;

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutCtrl = c;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrCtrl = c;
    },
  });
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });

  return {
    stdout,
    stderr,
    kill() {
      killed = true;
      try {
        stdoutCtrl.close();
      } catch {
        /* */
      }
      try {
        stderrCtrl.close();
      } catch {
        /* */
      }
      exitResolve(1);
    },
    get exited() {
      return exited;
    },
    get wasKilled() {
      return killed;
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
    const splitAt = Math.floor(combined.length * 0.4);
    const chunk1 = combined.slice(0, splitAt);
    const chunk2 = combined.slice(splitAt);

    const encoder = new TextEncoder();
    let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let exitResolve!: (code: number) => void;

    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtrl = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtrl = c;
      },
    });
    const exited = new Promise<number>((r) => {
      exitResolve = r;
    });

    void Promise.resolve().then(() => {
      stdoutCtrl.enqueue(encoder.encode(chunk1));
      stdoutCtrl.enqueue(encoder.encode(chunk2));
      stdoutCtrl.close();
      stderrCtrl.close();
      exitResolve(0);
    });

    const proc: SubprocessLike = {
      stdout,
      stderr,
      kill() {
        try {
          stdoutCtrl.close();
        } catch {
          /* */
        }
        try {
          stderrCtrl.close();
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

    expect(result.status).toBe('done');
    expect(result.totalCostUsd).toBeCloseTo(0.048494550000000004, 10);
  });

  it('skips malformed JSON lines without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines = loadFixture('write-success.jsonl');
    const withJunk = [...lines.slice(0, 5), '!!not-json!!', ...lines.slice(5)];

    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(withJunk));
    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    // Raw content is intentionally NOT logged (security: tool payloads must
    // not appear in application logs). Assert only that the marker is emitted.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[claude-code] Malformed JSON line'),
    );
    consoleSpy.mockRestore();
  });

  it('cancel() resolves wait() with cancelled status', async () => {
    const encoder = new TextEncoder();
    let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let exitResolve!: (code: number) => void;

    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtrl = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtrl = c;
      },
    });
    const exited = new Promise<number>((r) => {
      exitResolve = r;
    });

    const proc: SubprocessLike = {
      stdout,
      stderr,
      kill() {
        try {
          stdoutCtrl.close();
        } catch {
          /* */
        }
        try {
          stderrCtrl.close();
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
    await session.cancel();
    const result = await session.wait();

    expect(result.status).toBe('cancelled');
    void encoder; // suppress unused warning
  });

  it('resolves wait() with error when process exits without emitting a result line', async () => {
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

  // ── New robustness tests ───────────────────────────────────────────────────

  it('includes stderr content in finalOutput when process exits without a result line', async () => {
    // No stdout lines (process crashes immediately), stderr has a diagnostic message
    const proc = makeFakeProcess([], {
      stderrContent: 'claude: command not found\nError: ENOENT',
    });
    const runtime = new ClaudeCodeRuntime(() => proc);

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[stderr]');
    expect(result.finalOutput).toContain('command not found');
  });

  it('stderr is NOT included in finalOutput when the process completes normally', async () => {
    // Even if stderr has content, a successful result line takes precedence
    const lines = loadFixture('write-success.jsonl');
    const proc = makeFakeProcess(lines, { stderrContent: 'some warning on stderr' });
    const runtime = new ClaudeCodeRuntime(() => proc);

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    // Happy path: finalOutput comes from result.result, not from stderr
    expect(result.status).toBe('done');
    expect(result.finalOutput).not.toContain('[stderr]');
    expect(result.finalOutput).not.toContain('some warning on stderr');
  });

  it('timeout fires when process never emits a result line, kills the process', async () => {
    const proc = makeHangingProcess();
    // Use a very short timeout so the test runs quickly
    const runtime = new ClaudeCodeRuntime(() => proc, { timeoutMs: 50 });

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[timeout]');
    expect(result.finalOutput).toContain('50ms');
    expect(proc.wasKilled).toBe(true);
  });

  it('timeout is cleared when the session completes normally (no dangling timer)', async () => {
    const lines = loadFixture('write-success.jsonl');
    // Short timeout — but the process completes before it fires
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(lines), { timeoutMs: 10_000 });

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    // Normal completion: timer should have been cleared, not fired
    expect(result.status).toBe('done');
  });

  it('cancel() durationMs is non-negative when called before run() completes', async () => {
    const proc = makeHangingProcess();
    const runtime = new ClaudeCodeRuntime(() => proc, { timeoutMs: 30_000 });

    const session = await runtime.spawn(makeParams());
    // Cancel immediately — startMs was set in constructor, so durationMs >= 0
    await session.cancel();
    const result = await session.wait();

    expect(result.status).toBe('cancelled');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
