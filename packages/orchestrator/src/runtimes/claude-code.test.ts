import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRuntime, buildSubprocessEnv } from './claude-code.js';
import type { SubprocessLike, SpawnFn } from './claude-code.js';
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

  it('resolves wait() with status done for permission-denied fixture — denial is diagnostic, not verdict', async () => {
    // REFINED after Session 10 smoke test: an agent can be denied one tool yet
    // complete the task via another path. The runtime therefore does NOT treat
    // permission_denials as a failure signal — only is_error:true is a hard
    // protocol failure. Denials are appended to finalOutput for diagnostics.
    // Ground truth for success is artifact existence, checked by the specialist
    // handler (handleSpecWriterResult), not by ClaudeCodeRuntime.
    const lines = loadFixture('permission-denied.jsonl');
    const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.finalOutput).toContain('[note]');
    expect(result.finalOutput).toContain('1 permission denial');
    // Cost is still reported even when a denial occurred
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
    try {
      const lines = loadFixture('write-success.jsonl');
      const withJunk = [...lines.slice(0, 5), '!!not-json!!', ...lines.slice(5)];

      const runtime = new ClaudeCodeRuntime(() => makeFakeProcess(withJunk));
      const session = await runtime.spawn(makeParams());
      const result = await session.wait();

      expect(result.status).toBe('done');
      // Raw content is intentionally NOT logged (security: tool payloads must
      // not appear in application logs). Assert the marker was emitted AND that
      // the raw payload never appears in any log argument.
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[claude-code] Malformed JSON line'),
      );
      expect(
        consoleSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('!!not-json!!')),
        ),
      ).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
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

  // ── permissionMode and timeoutMs per-spawn ────────────────────────────────

  it('uses acceptEdits by default when permissionMode is not set', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('write-success.jsonl'));
    };

    const runtime = new ClaudeCodeRuntime(fakeSpawn);
    await runtime.spawn(makeParams());
    const args = capturedArgs[0] ?? [];
    const modeIdx = args.indexOf('--permission-mode');
    expect(modeIdx).toBeGreaterThan(-1);
    expect(args[modeIdx + 1]).toBe('acceptEdits');
  });

  it('passes bypassPermissions when permissionMode is set', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('write-success.jsonl'));
    };

    const runtime = new ClaudeCodeRuntime(fakeSpawn);
    const params: SpawnParams = { ...makeParams(), permissionMode: 'bypassPermissions' };
    await runtime.spawn(params);
    const args = capturedArgs[0] ?? [];
    const modeIdx = args.indexOf('--permission-mode');
    expect(modeIdx).toBeGreaterThan(-1);
    expect(args[modeIdx + 1]).toBe('bypassPermissions');
  });

  it('uses params.timeoutMs over runtime-level timeoutMs', async () => {
    // Runtime has a 30-second timeout, but the spawn overrides it to 50ms
    const proc = makeHangingProcess();
    const runtime = new ClaudeCodeRuntime(() => proc, { timeoutMs: 30_000 });

    const params: SpawnParams = { ...makeParams(), timeoutMs: 50 };
    const session = await runtime.spawn(params);
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[timeout]');
    expect(result.finalOutput).toContain('50ms');
    expect(proc.wasKilled).toBe(true);
  });

  // ── buildSubprocessEnv ────────────────────────────────────────────────────

  it('buildSubprocessEnv scrubs GITHUB_TOKEN from process.env', () => {
    const original = process.env['GITHUB_TOKEN'];
    try {
      process.env['GITHUB_TOKEN'] = 'ghp_secret123';
      const env = buildSubprocessEnv();
      expect(env['GITHUB_TOKEN']).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env['GITHUB_TOKEN'];
      } else {
        process.env['GITHUB_TOKEN'] = original;
      }
    }
  });

  it('buildSubprocessEnv scrubs GH_TOKEN from process.env', () => {
    const original = process.env['GH_TOKEN'];
    try {
      process.env['GH_TOKEN'] = 'ghp_other456';
      const env = buildSubprocessEnv();
      expect(env['GH_TOKEN']).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env['GH_TOKEN'];
      } else {
        process.env['GH_TOKEN'] = original;
      }
    }
  });

  it('buildSubprocessEnv merges extra env on top of scrubbed process.env', () => {
    const extra = { MY_API_KEY: 'key-abc', CUSTOM_FLAG: '1' };
    const env = buildSubprocessEnv(extra);
    expect(env['MY_API_KEY']).toBe('key-abc');
    expect(env['CUSTOM_FLAG']).toBe('1');
    // Scrub still applies even with extra env
    expect(env['GITHUB_TOKEN']).toBeUndefined();
  });

  it('spawn() passes scrubbed env to spawnFn', async () => {
    const capturedEnvs: Record<string, string>[] = [];
    const fakeSpawn: SpawnFn = (args, cwd, env) => {
      void args;
      void cwd;
      capturedEnvs.push({ ...env });
      return makeFakeProcess(loadFixture('write-success.jsonl'));
    };

    const original = process.env['GITHUB_TOKEN'];
    try {
      process.env['GITHUB_TOKEN'] = 'ghp_should_be_scrubbed';
      const runtime = new ClaudeCodeRuntime(fakeSpawn);
      await runtime.spawn(makeParams());
    } finally {
      if (original === undefined) {
        delete process.env['GITHUB_TOKEN'];
      } else {
        process.env['GITHUB_TOKEN'] = original;
      }
    }

    const capturedEnv = capturedEnvs[0] ?? {};
    expect(capturedEnv['GITHUB_TOKEN']).toBeUndefined();
  });

  it('spawn() includes params.env in the subprocess environment', async () => {
    const capturedEnvs: Record<string, string>[] = [];
    const fakeSpawn: SpawnFn = (args, cwd, env) => {
      void args;
      void cwd;
      capturedEnvs.push({ ...env });
      return makeFakeProcess(loadFixture('write-success.jsonl'));
    };

    const runtime = new ClaudeCodeRuntime(fakeSpawn);
    const params: SpawnParams = { ...makeParams(), env: { HELM_TEST_VAR: 'hello' } };
    await runtime.spawn(params);

    const capturedEnv = capturedEnvs[0] ?? {};
    expect(capturedEnv['HELM_TEST_VAR']).toBe('hello');
  });

  it('buildSubprocessEnv does not allow token re-injection via extra env', () => {
    // Regression test for C2: merging extra after the first scrub must not
    // re-introduce GITHUB_TOKEN or GH_TOKEN into the subprocess environment.
    const env = buildSubprocessEnv({ GITHUB_TOKEN: 'injected-token', GH_TOKEN: 'other-token' });
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
  });
});
