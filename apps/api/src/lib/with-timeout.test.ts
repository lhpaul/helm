import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACKER_WRITE_TIMEOUT_MS, withTimeout } from './with-timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'fast')).resolves.toBe(42);
  });

  it('propagates a rejection that occurs before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'rej')).rejects.toThrow(
      'boom',
    );
  });

  it('rejects with a labelled timeout error when the promise never settles', async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {});
    const p = withTimeout(pending, 100, 'stuck');
    // Attach the rejection assertion before advancing so it is never unhandled.
    const assertion = expect(p).rejects.toThrow('stuck timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('defaults the tracker-write bound to 10s (registerWebhook precedent)', () => {
    expect(TRACKER_WRITE_TIMEOUT_MS).toBe(10_000);
  });
});
