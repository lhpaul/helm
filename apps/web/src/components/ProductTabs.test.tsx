import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductTabs } from './ProductTabs.js';

// ── Mock api ──────────────────────────────────────────────────────────────────

const { mockListProducts } = vi.hoisted(() => ({ mockListProducts: vi.fn() }));

vi.mock('../lib/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/api.js')>();
  return { ...real, api: { ...real.api, listProducts: mockListProducts } };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRODUCTS = [
  { product: { slug: 'helm', name: 'Helm' }, workflow: { stages_enabled: [] } },
  {
    product: { slug: 'helm-playground', name: 'Helm Playground' },
    workflow: { stages_enabled: [] },
  },
];

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function err(message: string) {
  return { ok: false as const, error: { type: 'network' as const, message } };
}

function renderTabs(initialPath = '/products/helm') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/products/:slug" element={<ProductTabs />} />
        <Route path="/products/:slug/items/:externalId" element={<ProductTabs />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProductTabs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders a tab for each product', async () => {
    mockListProducts.mockResolvedValue(ok(PRODUCTS));
    renderTabs();

    await vi.waitFor(() => {
      expect(screen.getByText('Helm')).toBeInTheDocument();
      expect(screen.getByText('Helm Playground')).toBeInTheDocument();
    });
  });

  it('marks the active tab based on the current slug', async () => {
    mockListProducts.mockResolvedValue(ok(PRODUCTS));
    renderTabs('/products/helm-playground');

    await vi.waitFor(() => {
      const activeLink = screen.getByRole('link', { name: 'Helm Playground' });
      expect(activeLink).toHaveAttribute('aria-current', 'page');
      const inactiveLink = screen.getByRole('link', { name: 'Helm' });
      expect(inactiveLink).not.toHaveAttribute('aria-current');
    });
  });

  it('each tab links to /products/:slug', async () => {
    mockListProducts.mockResolvedValue(ok(PRODUCTS));
    renderTabs();

    await vi.waitFor(() => {
      expect(screen.getByRole('link', { name: 'Helm' })).toHaveAttribute('href', '/products/helm');
      expect(screen.getByRole('link', { name: 'Helm Playground' })).toHaveAttribute(
        'href',
        '/products/helm-playground',
      );
    });
  });

  it('shows error state when listProducts fails', async () => {
    mockListProducts.mockResolvedValue(err('Network error'));
    renderTabs();

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to load products/)).toBeInTheDocument();
    });
  });

  it('renders nothing when product list is empty', async () => {
    mockListProducts.mockResolvedValue(ok([]));
    const { container } = renderTabs();

    await vi.waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('re-fetches products after polling interval', async () => {
    mockListProducts.mockResolvedValue(ok(PRODUCTS));
    renderTabs();

    await vi.waitFor(() => expect(mockListProducts).toHaveBeenCalledTimes(1));

    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(mockListProducts).toHaveBeenCalledTimes(2));
  });
});
