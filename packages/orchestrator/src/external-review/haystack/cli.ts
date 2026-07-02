import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunHaystack } from './types.js';

const execFileAsync = promisify(execFile);

function isExecException(err: unknown): err is NodeJS.ErrnoException & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string;
} {
  return typeof err === 'object' && err !== null && ('stdout' in err || 'code' in err);
}

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.toString('utf8');
}

/** Default injectable runner for `haystack` CLI invocations. */
export const defaultRunHaystack: RunHaystack = async (args, opts) => {
  const timeoutMs = opts?.timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const { stdout, stderr } = await execFileAsync('haystack', args, {
      env: process.env,
      signal: controller.signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: toText(stdout), stderr: toText(stderr), exitCode: 0 };
  } catch (err) {
    if (isExecException(err)) {
      if (err.code === 'ABORT_ERR' || err.code === 'ERR_ABORTED') {
        return { stdout: '', stderr: 'timeout', exitCode: 124 };
      }
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      return {
        stdout: toText(err.stdout),
        stderr: toText(err.stderr),
        exitCode,
      };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { stdout: '', stderr: 'timeout', exitCode: 124 };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
