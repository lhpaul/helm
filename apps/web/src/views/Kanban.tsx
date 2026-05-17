import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { ItemState } from '../lib/api.js';
import type { WorkflowStage } from '@helm/workflow';
import { usePolling } from '../hooks/usePolling.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ItemCard({ item }: { item: ItemState }) {
  return (
    <Link
      to={`/items/${item.externalId}`}
      className="block rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md"
    >
      <p className="truncate text-sm font-medium text-gray-900">{item.externalId}</p>
      <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{item.externalId}</p>
      <p className="mt-2 text-xs text-gray-400">{relativeTime(item.createdAt)}</p>
    </Link>
  );
}

function KanbanColumn({ stage, items }: { stage: WorkflowStage; items: ItemState[] }) {
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{stage}</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <ItemCard key={item.externalId} item={item} />
        ))}
        {items.length === 0 && <p className="py-4 text-center text-xs text-gray-300">—</p>}
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function Kanban() {
  const fetchProduct = useCallback(() => api.getProduct(), []);
  const fetchItems = useCallback(() => api.listItems(), []);

  const { data: product, error: productError, loading } = usePolling(fetchProduct, null);
  const { data: items, error: itemsError } = usePolling(fetchItems, 5_000);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  if (productError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{productError}</p>
      </div>
    );
  }

  const stages = product?.workflow.stages_enabled ?? [];
  const allItems = items ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">
            Helm
            {product && (
              <span className="ml-2 text-sm font-normal text-gray-400">
                / {product.product.name}
              </span>
            )}
          </h1>
          {itemsError && <p className="text-xs text-red-500">⚠ {itemsError}</p>}
        </div>
      </header>

      {/* Board */}
      <main className="flex flex-1 gap-4 overflow-x-auto p-6">
        {stages.map((stage) => (
          <KanbanColumn
            key={stage}
            stage={stage}
            items={allItems.filter((i) => i.currentStage === stage)}
          />
        ))}
      </main>
    </div>
  );
}
