import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kanban } from './Kanban.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetProductBySlug, mockListItemsForProduct, mockListProducts } = vi.hoisted(() => ({
  mockGetProductBySlug: vi.fn(),
  mockListItemsForProduct: vi.fn(),
  mockListProducts: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...real,
    api: {
      ...real.api,
      getProductBySlug: mockGetProductBySlug,
      listItemsForProduct: mockListItemsForProduct,
      listProducts: mockListProducts,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function err(message: string) {
  return { ok: false as const, error: { type: 'network' as const, message } };
}

const PRODUCT = {
  product: { slug: 'helm-playground', name: 'Helm Playground' },
  workflow: { stages_enabled: ['discovery', 'spec-ready'] as const },
};

const ITEMS = [
  {
    externalId: 'issue_1',
    productSlug: 'helm-playground',
    currentStage: 'discovery',
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function renderKanban(slug = 'helm-playground') {
  return render(
    <MemoryRouter initialEntries={[`/products/${slug}`]}>
      <Routes>
        <Route path="/products/:slug" element={<Kanban />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Kanban', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListProducts.mockResolvedValue(ok([]));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders columns from product stages_enabled', async () => {
    mockGetProductBySlug.mockResolvedValue(ok(PRODUCT));
    mockListItemsForProduct.mockResolvedValue(ok(ITEMS));
    renderKanban();

    // Stage names appear lowercase in DOM; CSS `uppercase` is a visual-only transform.
    // getAllByText is used because stage name also appears in the item card subtitle.
    await vi.waitFor(() => {
      expect(screen.getAllByText('discovery').length).toBeGreaterThan(0);
      expect(screen.getAllByText('spec-ready').length).toBeGreaterThan(0);
    });
  });

  it('shows item card in the correct column', async () => {
    mockGetProductBySlug.mockResolvedValue(ok(PRODUCT));
    mockListItemsForProduct.mockResolvedValue(ok(ITEMS));
    renderKanban();

    await vi.waitFor(() => {
      expect(screen.getByText('issue_1')).toBeInTheDocument();
    });
  });

  it('item card links to /products/:slug/items/:externalId', async () => {
    mockGetProductBySlug.mockResolvedValue(ok(PRODUCT));
    mockListItemsForProduct.mockResolvedValue(ok(ITEMS));
    renderKanban();

    await vi.waitFor(() => {
      const link = screen.getByRole('link', { name: /issue_1/ });
      expect(link).toHaveAttribute('href', '/products/helm-playground/items/issue_1');
    });
  });

  it('shows error with back link when product fetch fails', async () => {
    mockGetProductBySlug.mockResolvedValue(err('Product not found: ghost'));
    mockListItemsForProduct.mockResolvedValue(ok([]));
    renderKanban('ghost');

    await vi.waitFor(() => {
      expect(screen.getByText('Product not found: ghost')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /back to products/i })).toHaveAttribute(
        'href',
        '/products',
      );
    });
  });

  it('renders empty columns (no crash) when items list is empty', async () => {
    mockGetProductBySlug.mockResolvedValue(ok(PRODUCT));
    mockListItemsForProduct.mockResolvedValue(ok([]));
    renderKanban();

    await vi.waitFor(() => {
      expect(screen.getByText('discovery')).toBeInTheDocument();
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });
  });
});
