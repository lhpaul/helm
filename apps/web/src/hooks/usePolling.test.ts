import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling.js';
import type { ApiResult } from '../lib/api.js';

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}
function err(message: string): ApiResult<never> {
  return { ok: false, error: { type: 'network', message } };
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in loading state and populates data on first fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ count: 1 }));

    const { result } = renderHook(() => usePolling(fetcher, 5_000));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ count: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after each interval tick', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ count: 1 }));
    renderHook(() => usePolling(fetcher, 1_000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('clears the interval on unmount', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({}));
    const { unmount } = renderHook(() => usePolling(fetcher, 1_000));

    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1); // only the initial fetch
  });

  it('sets error and clears data on fetch failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(err('Failed to fetch'));
    const { result } = renderHook(() => usePolling(fetcher, 5_000));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Failed to fetch');
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('clears error when a subsequent poll succeeds', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(err('Network error'))
      .mockResolvedValue(ok({ value: 42 }));

    const { result } = renderHook(() => usePolling(fetcher, 1_000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBe('Network error');

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ value: 42 });
  });

  it('fetches once and does not poll when intervalMs is null', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({}));
    renderHook(() => usePolling(fetcher, null));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1); // still just once
  });
});
