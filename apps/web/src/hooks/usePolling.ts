import { useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../lib/api.js';

export type PollingState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

/**
 * Fetches immediately, then polls at `intervalMs`.
 * Pass `intervalMs = null` to fetch once and skip polling.
 * The fetcher reference is kept stable via a ref so callers can pass
 * inline arrow functions without causing the effect to re-run.
 *
 * Guards:
 * - `inFlight`: skips a tick if the previous request is still pending,
 *   preventing overlapping requests and out-of-order state writes.
 * - try-catch: maps thrown errors (not just { ok: false } returns) to the
 *   error state so unhandled rejections never bubble up.
 */
export function usePolling<T>(
  fetcher: () => Promise<ApiResult<T>>,
  intervalMs: number | null = 5_000,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const doFetch = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        if (result.ok) {
          setData(result.data);
          setError(null);
        } else {
          setError(result.error.message);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unexpected polling error');
      } finally {
        inFlight = false;
        setLoading(false);
      }
    };

    void doFetch();

    if (intervalMs === null)
      return () => {
        cancelled = true;
      };

    const id = setInterval(() => {
      void doFetch();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { data, error, loading };
}
