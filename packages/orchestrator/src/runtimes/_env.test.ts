import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSpawn, type SubprocessLike } from './_env.js';

// `defaultSpawn` is the only spawn-based primitive not exercised through the
// runtime suites (those inject a fake SpawnFn). We test it directly here:
//  1. the Bun-unavailable guard throws a clear error, and
//  2. when Bun is present, stdio is wired non-blocking (stdin:'ignore') with
//     stdout/stderr piped — a regression here would silently reintroduce the
//     stdin-blocking hang documented in the defaultSpawn comment.

describe('defaultSpawn', () => {
  const originalBun = (globalThis as Record<string, unknown>)['Bun'];

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as Record<string, unknown>)['Bun'];
    } else {
      (globalThis as Record<string, unknown>)['Bun'] = originalBun;
    }
    vi.restoreAllMocks();
  });

  it('throws a clear error when the Bun runtime is unavailable', () => {
    delete (globalThis as Record<string, unknown>)['Bun'];
    expect(() => defaultSpawn(['echo', 'hi'], '/tmp', {})).toThrow(
      /Spawn-based runtimes require the Bun runtime/,
    );
  });

  it('delegates to Bun.spawn with non-blocking stdin and piped stdout/stderr', () => {
    const fakeChild = {} as SubprocessLike;
    const spawn = vi.fn().mockReturnValue(fakeChild);
    (globalThis as Record<string, unknown>)['Bun'] = { spawn };

    const args = ['codex', 'exec', '--json'];
    const env = { FOO: 'bar' };
    const result = defaultSpawn(args, '/work/dir', env);

    expect(result).toBe(fakeChild);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(args, {
      cwd: '/work/dir',
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
  });
});
