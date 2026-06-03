import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexRuntime } from './codex.js';
import { buildSubprocessEnv, defaultSpawn } from './_env.js';
import type { SubprocessLike, SpawnFn } from './_env.js';
import type { AgentMessage, SpawnParams } from '../runtime.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dirname, '__fixtures__', 'codex');

function loadFixture(name: string): string[] {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

/**
 * Creates a fake SubprocessLike whose stdout emits the given JSONL lines and
 * whose stderr emits optional diagnostic text. Lines are enqueued as microtasks
 * so onMessage handlers registered after spawn() capture all events.
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

/** A fake process whose stdout never closes — simulates a hung process. */
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
  specialistId: 'implementer',
  prompt: 'Create hello.txt.',
  workdir,
  productSlug: 'test-product',
  externalId: 'issue_1',
  model: 'gpt-5-codex',
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CodexRuntime', () => {
  it('resolves wait() with status done and the last agent_message as finalOutput', async () => {
    const lines = loadFixture('exec-success.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.finalOutput).toContain('hello.txt');
    expect(result.finalOutput).toContain('confirmed it exists');
  });

  it('reports totalCostUsd 0 — subscription-covered, no USD figure emitted', async () => {
    const lines = loadFixture('exec-success.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.totalCostUsd).toBe(0);
  });

  it('emits agent_message items as role:agent', async () => {
    const lines = loadFixture('exec-success.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    const textMsgs = received.filter((m) => m.role === 'agent');
    expect(textMsgs.length).toBeGreaterThan(0);
    expect(textMsgs[0]?.content).toBeTruthy();
  });

  it('emits command_execution items as role:tool with the command and exit code', async () => {
    const lines = loadFixture('exec-success.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    const toolMsgs = received.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(toolMsgs[0]?.content).toContain('[exec]');
    expect(toolMsgs[0]?.content).toContain('hello.txt');
    expect(toolMsgs[0]?.content).toContain('(exit 0)');
  });

  it('does NOT emit a duplicate for item.started (only item.completed surfaces)', async () => {
    const lines = loadFixture('exec-success.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    // Fixture has one command_execution (item.started + item.completed); only
    // the completed event should surface as a single tool message.
    const toolMsgs = received.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
  });

  it('resolves wait() with status error on a turn.failed event', async () => {
    const lines = loadFixture('turn-failed.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[turn.failed]');
    expect(result.finalOutput).toContain('not supported');
  });

  it('resolves wait() with error when the process exits without a terminal turn event', async () => {
    // Only thread.started + turn.started, no turn.completed/turn.failed.
    const lines = loadFixture('exec-success.jsonl').slice(0, 2);
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
  });

  it('handles partial-line buffering — splits a fixture across two unaligned chunks', async () => {
    const lines = loadFixture('exec-success.jsonl');
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

    const runtime = new CodexRuntime(() => proc);
    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.finalOutput).toContain('hello.txt');
  });

  it('skips malformed JSON lines without crashing or logging raw content', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const lines = loadFixture('exec-success.jsonl');
      const withJunk = [...lines.slice(0, 2), '!!not-json!!', ...lines.slice(2)];

      const runtime = new CodexRuntime(() => makeFakeProcess(withJunk));
      const session = await runtime.spawn(makeParams());
      const result = await session.wait();

      expect(result.status).toBe('done');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[codex] Malformed JSON line'),
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
    const proc = makeHangingProcess();
    const runtime = new CodexRuntime(() => proc, { timeoutMs: 30_000 });

    const session = await runtime.spawn(makeParams());
    await session.cancel();
    const result = await session.wait();

    expect(result.status).toBe('cancelled');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(proc.wasKilled).toBe(true);
  });

  it('includes stderr content in finalOutput when the process exits abnormally', async () => {
    const proc = makeFakeProcess([], {
      stderrContent: 'codex: command not found\nError: ENOENT',
    });
    const runtime = new CodexRuntime(() => proc);

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[stderr]');
    expect(result.finalOutput).toContain('command not found');
  });

  it('stderr is NOT included in finalOutput when the turn completes normally', async () => {
    const lines = loadFixture('exec-success.jsonl');
    const proc = makeFakeProcess(lines, {
      stderrContent: 'Reading additional input from stdin...',
    });
    const runtime = new CodexRuntime(() => proc);

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.finalOutput).not.toContain('[stderr]');
  });

  it('timeout fires when no terminal turn event arrives, and kills the process', async () => {
    const proc = makeHangingProcess();
    const runtime = new CodexRuntime(() => proc, { timeoutMs: 50 });

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[timeout]');
    expect(result.finalOutput).toContain('50ms');
    expect(proc.wasKilled).toBe(true);
  });

  it('uses params.timeoutMs over runtime-level timeoutMs', async () => {
    const proc = makeHangingProcess();
    const runtime = new CodexRuntime(() => proc, { timeoutMs: 30_000 });

    const params: SpawnParams = { ...makeParams(), timeoutMs: 50 };
    const session = await runtime.spawn(params);
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('50ms');
    expect(proc.wasKilled).toBe(true);
  });

  // ── Args: headless flags, sandbox mapping, model ──────────────────────────

  it('spawn() builds codex exec --json --skip-git-repo-check args', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    await runtime.spawn(makeParams());

    const args = capturedArgs[0] ?? [];
    expect(args[0]).toBe('codex');
    expect(args[1]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    // Prompt is fed over stdin, NOT as a positional argument (ADR-028).
    expect(args).not.toContain('Create hello.txt.');
  });

  it('pins the working root with -C <workdir> (authoritative over spawn cwd)', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    await runtime.spawn(makeParams('/tmp/the-workdir'));

    const args = capturedArgs[0] ?? [];
    const idx = args.indexOf('-C');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/tmp/the-workdir');
  });

  it('feeds the prompt over stdin (off the argv) and keeps cwd as the workdir', async () => {
    let capturedStdin: Uint8Array | undefined;
    let capturedCwd: string | undefined;
    const fakeSpawn: SpawnFn = (args, cwd, env, stdin) => {
      void args;
      void env;
      capturedCwd = cwd;
      capturedStdin = stdin;
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    await runtime.spawn(makeParams('/tmp/the-workdir'));

    expect(capturedStdin).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(capturedStdin)).toBe('Create hello.txt.');
    // spawn cwd retained as the fallback root if a future CLI drops -C.
    expect(capturedCwd).toBe('/tmp/the-workdir');
  });

  it('maps acceptEdits (default) to --sandbox workspace-write', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    await runtime.spawn(makeParams());

    const args = capturedArgs[0] ?? [];
    const idx = args.indexOf('--sandbox');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('workspace-write');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('maps bypassPermissions to --dangerously-bypass-approvals-and-sandbox', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    const params: SpawnParams = { ...makeParams(), permissionMode: 'bypassPermissions' };
    await runtime.spawn(params);

    const args = capturedArgs[0] ?? [];
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
  });

  it('passes --model when params.model is set', async () => {
    const capturedArgs: string[][] = [];
    const fakeSpawn: SpawnFn = (args) => {
      capturedArgs.push([...args]);
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    await runtime.spawn(makeParams());

    const args = capturedArgs[0] ?? [];
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('gpt-5-codex');
  });

  // ── Env scrubbing ─────────────────────────────────────────────────────────

  it('scrubs OPENAI_API_KEY, CODEX_API_KEY and git tokens from the subprocess env', async () => {
    const capturedEnvs: Record<string, string>[] = [];
    const fakeSpawn: SpawnFn = (args, cwd, env) => {
      void args;
      void cwd;
      capturedEnvs.push({ ...env });
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const originals = {
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      CODEX_API_KEY: process.env['CODEX_API_KEY'],
      CODEX_ACCESS_TOKEN: process.env['CODEX_ACCESS_TOKEN'],
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
    };
    try {
      process.env['OPENAI_API_KEY'] = 'sk-secret';
      process.env['CODEX_API_KEY'] = 'codex-secret';
      process.env['CODEX_ACCESS_TOKEN'] = 'access-secret';
      process.env['GITHUB_TOKEN'] = 'ghp_secret';

      const runtime = new CodexRuntime(fakeSpawn);
      await runtime.spawn(makeParams());
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    const env = capturedEnvs[0] ?? {};
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['CODEX_API_KEY']).toBeUndefined();
    expect(env['CODEX_ACCESS_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
  });

  it('does not let params.env re-inject a scrubbed OpenAI credential', async () => {
    const capturedEnvs: Record<string, string>[] = [];
    const fakeSpawn: SpawnFn = (args, cwd, env) => {
      void args;
      void cwd;
      capturedEnvs.push({ ...env });
      return makeFakeProcess(loadFixture('exec-success.jsonl'));
    };

    const runtime = new CodexRuntime(fakeSpawn);
    const params: SpawnParams = {
      ...makeParams(),
      env: { OPENAI_API_KEY: 'sneaky', HELM_OK: 'yes' },
    };
    await runtime.spawn(params);

    const env = capturedEnvs[0] ?? {};
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    // Non-credential extras still pass through.
    expect(env['HELM_OK']).toBe('yes');
  });

  // ── send() ────────────────────────────────────────────────────────────────

  it('send() throws — mid-flight steering is unsupported in one-shot exec mode', async () => {
    const runtime = new CodexRuntime(() => makeFakeProcess(loadFixture('exec-success.jsonl')));
    const session = await runtime.spawn(makeParams());
    await expect(session.send('do something else')).rejects.toThrow(/not supported/);
    await session.wait();
  });

  // ── buildSubprocessEnv reused by CodexRuntime ──────────────────────────────

  it('buildSubprocessEnv scrubs a custom key list', () => {
    const original = process.env['OPENAI_API_KEY'];
    try {
      process.env['OPENAI_API_KEY'] = 'sk-secret';
      const env = buildSubprocessEnv(undefined, ['OPENAI_API_KEY']);
      expect(env['OPENAI_API_KEY']).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = original;
    }
  });
});

// ── Real Codex CLI 0.136.0 capture (ADR-028) ──────────────────────────────────
// These fixtures are verbatim stdout from `codex exec --json` on v0.136.0. They
// lock the runtime against the actual 0.136 event schema, which added the
// `aggregated_output`/`status` fields on command_execution, a new `file_change`
// item type, and a JSON-stringified nested payload inside turn.failed.error.message.

describe('CodexRuntime — real 0.136.0 JSONL schema', () => {
  it('parses a real success run: status done, last agent_message as finalOutput', async () => {
    const lines = loadFixture('exec-success-0.136.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('done');
    expect(result.finalOutput).toBe('Created `greeting.txt` containing `hello`.');
  });

  it('tolerates the new file_change item type — only command_execution surfaces as tool', async () => {
    const lines = loadFixture('exec-success-0.136.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const received: AgentMessage[] = [];
    session.onMessage((m) => received.push(m));
    await session.wait();

    // Fixture has two command_execution completions (git remote -v, cat) and one
    // file_change completion; the file_change must NOT produce a message.
    const toolMsgs = received.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]?.content).toContain('[exec]');
    expect(toolMsgs[1]?.content).toContain('cat greeting.txt');
    expect(toolMsgs[1]?.content).toContain('(exit 0)');
    expect(received.some((m) => m.content.includes('file_change'))).toBe(false);
  });

  it('propagates a real turn.failed message into finalOutput (#47 patch survives)', async () => {
    const lines = loadFixture('turn-failed-0.136.jsonl');
    const runtime = new CodexRuntime(() => makeFakeProcess(lines));

    const session = await runtime.spawn(makeParams());
    const result = await session.wait();

    expect(result.status).toBe('error');
    expect(result.finalOutput).toContain('[turn.failed]');
    expect(result.finalOutput).toContain('not supported');
  });
});

// ── defaultSpawn stdin branching (ADR-028) ────────────────────────────────────
// The stdin conditional is load-bearing: a regression to always `'ignore'` would
// strip the Codex prompt (delivered over stdin), so child processes would receive
// no instructions. defaultSpawn calls Bun.spawn directly, so we stub globalThis.Bun
// to capture the options object instead of spawning a real process.

describe('defaultSpawn — stdin handling', () => {
  function withStubbedBun<T>(fn: (calls: Array<{ stdin: unknown }>) => T): T {
    const calls: Array<{ stdin: unknown }> = [];
    const g = globalThis as Record<string, unknown>;
    const original = g['Bun'];
    g['Bun'] = {
      spawn(_args: string[], opts: { stdin: unknown }) {
        calls.push({ stdin: opts.stdin });
        return makeFakeProcess([]) as unknown as SubprocessLike;
      },
    };
    try {
      return fn(calls);
    } finally {
      if (original === undefined) delete g['Bun'];
      else g['Bun'] = original;
    }
  }

  it('passes a stdin buffer through to Bun.spawn when provided', () => {
    withStubbedBun((calls) => {
      const buf = new TextEncoder().encode('the prompt');
      defaultSpawn(['codex', 'exec'], '/tmp/wd', {}, buf);
      expect(calls[0]?.stdin).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(calls[0]?.stdin as Uint8Array)).toBe('the prompt');
    });
  });

  it("falls back to stdin:'ignore' when no buffer is provided (ClaudeCodeRuntime path)", () => {
    withStubbedBun((calls) => {
      defaultSpawn(['claude', '-p', 'prompt'], '/tmp/wd', {});
      expect(calls[0]?.stdin).toBe('ignore');
    });
  });

  it('throws a clear error when the Bun runtime is unavailable', () => {
    const g = globalThis as Record<string, unknown>;
    const original = g['Bun'];
    delete g['Bun'];
    try {
      expect(() => defaultSpawn(['codex'], '/tmp/wd', {})).toThrow(/require the Bun runtime/);
    } finally {
      if (original !== undefined) g['Bun'] = original;
    }
  });
});
