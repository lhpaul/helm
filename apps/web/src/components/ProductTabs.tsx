import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { usePolling } from '../hooks/usePolling.js';

/**
 * Horizontal product tabs rendered above every kanban/detail view.
 * Polls every 5s so newly-registered products appear without a page reload.
 */
export function ProductTabs() {
  const { slug } = useParams<{ slug?: string }>();
  const fetchProducts = useCallback(() => api.listProducts(), []);
  const { data: products, error, loading } = usePolling(fetchProducts, 5_000);

  // Blank bar while loading — avoids layout shift.
  if (loading) {
    return <div className="h-10 border-b border-gray-200 bg-white" />;
  }

  if (error) {
    return (
      <div className="border-b border-gray-200 bg-white px-6 py-2">
        <p className="text-xs text-red-500">⚠ Failed to load products</p>
      </div>
    );
  }

  if (!products?.length) return null;

  return (
    <nav aria-label="Products" className="border-b border-gray-200 bg-white px-6">
      <div className="flex">
        {products.map((product) => {
          const isActive = product.product.slug === slug;
          return (
            <Link
              key={product.product.slug}
              to={`/products/${product.product.slug}`}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'px-4 py-3 text-sm font-medium transition-colors',
                isActive
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'border-b-2 border-transparent text-gray-500 hover:text-gray-700',
              ].join(' ')}
            >
              {product.product.name}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
