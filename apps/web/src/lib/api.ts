import type { Product } from '@helm/shared';
import type { WorkflowStage } from '@helm/workflow';

// ── Types mirroring apps/api/src/services/types.ts ───────────────────────────
// These match the JSON shape returned by GET /api/items and GET /api/items/:id.
// Keep in sync when the API response shape changes.

export type WorkflowEvent = {
  fromStage: WorkflowStage | null;
  toStage: WorkflowStage;
  /** 'agent:spec-writer', 'human:lhpaul', 'webhook:github-projects', etc. */
  triggeredBy: string;
  /** ISO 8601 */
  at: string;
  note?: string;
};

export type ItemState = {
  externalId: string;
  productSlug: string;
  currentStage: WorkflowStage;
  /** Always has at least one entry (the creation event, fromStage = null). */
  history: WorkflowEvent[];
  createdAt: string;
  updatedAt: string;
};

export type { Product };

// ── Error types ───────────────────────────────────────────────────────────────

export type ApiError =
  | { type: 'network'; message: string }
  | { type: 'http'; status: number; message: string };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// ── Fetch helper ──────────────────────────────────────────────────────────────

const rawApiUrl = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
const BASE_URL = rawApiUrl && rawApiUrl.trim() ? rawApiUrl.trim() : '';

async function fetchJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
        error?: string;
      };
      return {
        ok: false,
        error: { type: 'http', status: res.status, message: body.error ?? res.statusText },
      };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'network',
        message: err instanceof Error ? err.message : 'Network error',
      },
    };
  }
}

// ── API client ────────────────────────────────────────────────────────────────

export const api = {
  getProduct: (): Promise<ApiResult<Product>> => fetchJson<Product>('/api/product'),
  listItems: (): Promise<ApiResult<ItemState[]>> => fetchJson<ItemState[]>('/api/items'),
  getItem: (id: string): Promise<ApiResult<ItemState>> =>
    fetchJson<ItemState>(`/api/items/${encodeURIComponent(id)}`),
};
