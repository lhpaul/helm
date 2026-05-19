import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockListProducts, mockGetProductBySlug, mockListItemsForProduct } = vi.hoisted(() => ({
  mockListProducts: vi.fn(),
  mockGetProductBySlug: vi.fn(),
  mockListItemsForProduct: vi.fn(),
}));

vi.mock('./lib/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/api.js')>();
  return {
    ...real,
    api: {
      ...real.api,
      listProducts: mockListProducts,
      getProductBySlug: mockGetProductBySlug,
      listItemsForProduct: mockListItemsForProduct,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok<T>(data: T) {
  const safeData =
    data && typeof data === 'object'
      ? Array.isArray(data)
        ? ([...data] as T)
        : ({ ...data } as T)
      : data;
  return { ok: true as const, data: safeData };
}

const PRODUCTS = [
  { product: { slug: 'helm', name: 'Helm' }, workflow: { stages_enabled: ['discovery'] as const } },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows empty state when registry returns no products', async () => {
    mockListProducts.mockResolvedValue(ok([]));
    render(<App />);

    await vi.waitFor(() => {
      expect(screen.getByText('No products registered.')).toBeInTheDocument();
    });
  });

  it('redirects / to /products/:firstSlug when products exist', async () => {
    mockListProducts.mockResolvedValue(ok(PRODUCTS));
    mockGetProductBySlug.mockResolvedValue(ok(PRODUCTS[0]));
    mockListItemsForProduct.mockResolvedValue(ok([]));
    render(<App />);

    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/products/helm');
      expect(screen.getByRole('heading', { name: /Helm/ })).toBeInTheDocument();
    });
  });
});
