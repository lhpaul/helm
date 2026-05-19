import { useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { ItemState } from '../lib/api.js';
import type { WorkflowStage } from '@helm/workflow';
import { usePolling } from '../hooks/usePolling.js';
import { ProductTabs } from '../components/ProductTabs.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return 'unknown';
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ItemCard({ item, slug }: { item: ItemState; slug: string }) {
  return (
    <Link
      to={`/products/${slug}/items/${item.externalId}`}
      className="block rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md"
    >
      <p className="truncate font-mono text-sm font-medium text-gray-900">{item.externalId}</p>
      <p className="mt-0.5 text-xs text-gray-500">{item.currentStage}</p>
      <p className="mt-2 text-xs text-gray-400">{relativeTime(item.createdAt)}</p>
    </Link>
  );
}

function KanbanColumn({
  stage,
  items,
  slug,
}: {
  stage: WorkflowStage;
  items: ItemState[];
  slug: string;
}) {
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
          <ItemCard key={item.externalId} item={item} slug={slug} />
        ))}
        {items.length === 0 && <p className="py-4 text-center text-xs text-gray-300">—</p>}
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function Kanban() {
  const { slug } = useParams<{ slug: string }>();

  const fetchProduct = useCallback(
    () =>
      slug
        ? api.getProductBySlug(slug)
        : Promise.resolve({
            ok: false as const,
            error: { type: 'network' as const, message: 'Missing product slug in route.' },
          }),
    [slug],
  );
  const fetchItems = useCallback(
    () =>
      slug
        ? api.listItemsForProduct(slug)
        : Promise.resolve({ ok: true as const, data: [] as ItemState[] }),
    [slug],
  );

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
      <div className="flex min-h-screen flex-col bg-gray-50">
        <ProductTabs />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-gray-500">{productError}</p>
            <Link
              to="/products"
              className="mt-3 block text-xs text-indigo-600 hover:text-indigo-800"
            >
              ← Back to products
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const stages = product?.workflow.stages_enabled ?? [];
  const allItems = items ?? [];

  const itemsByStage = useMemo(() => {
    const grouped = new Map<string, ItemState[]>();
    for (const item of allItems) {
      const list = grouped.get(item.currentStage) ?? [];
      list.push(item);
      grouped.set(item.currentStage, list);
    }
    return grouped;
  }, [allItems]);

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

      {/* Product tabs */}
      <ProductTabs />

      {/* Board */}
      <main className="flex flex-1 gap-4 overflow-x-auto p-6">
        {stages.map((stage) => (
          <KanbanColumn
            key={stage}
            stage={stage}
            items={itemsByStage.get(stage) ?? []}
            slug={slug ?? ''}
          />
        ))}
      </main>
    </div>
  );
}
