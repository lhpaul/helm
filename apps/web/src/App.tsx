import { useCallback } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Kanban } from './views/Kanban.js';
import { ItemDetail } from './views/ItemDetail.js';
import { api } from './lib/api.js';
import { usePolling } from './hooks/usePolling.js';

// ── Redirect helpers ──────────────────────────────────────────────────────────

/**
 * Resolves the first registered product slug and redirects to /products/:slug.
 * Shows an empty state if the registry is empty so the app never crashes.
 */
function ProductsRedirect() {
  const fetchProducts = useCallback(() => api.listProducts(), []);
  const { data: products, error, loading } = usePolling(fetchProducts, null);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-red-500">Failed to load products: {error}</p>
      </div>
    );
  }

  if (!products?.length) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-sm text-gray-500">No products registered.</p>
          <p className="mt-1 text-xs text-gray-400">
            Add a product to <code>.helm/products.yaml</code> and restart the server.
          </p>
        </div>
      </div>
    );
  }

  return <Navigate to={`/products/${encodeURIComponent(products[0]!.product.slug)}`} replace />;
}

/**
 * Legacy /items/:id → /products/:firstSlug/items/:id so old bookmarks still work.
 */
function LegacyItemRedirect() {
  const { id } = useParams<{ id: string }>();
  const fetchProducts = useCallback(() => api.listProducts(), []);
  const { data: products, error, loading } = usePolling(fetchProducts, null);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  if (error) return <Navigate to="/" replace />;
  if (!products?.length || !id) return <Navigate to="/" replace />;
  return (
    <Navigate
      to={`/products/${encodeURIComponent(products[0]!.product.slug)}/items/${encodeURIComponent(id)}`}
      replace
    />
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Multi-product routes */}
        <Route path="/products" element={<ProductsRedirect />} />
        <Route path="/products/:slug" element={<Kanban />} />
        <Route path="/products/:slug/items/:externalId" element={<ItemDetail />} />

        {/* Backward-compat redirects */}
        <Route path="/" element={<ProductsRedirect />} />
        <Route path="/items/:id" element={<LegacyItemRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
