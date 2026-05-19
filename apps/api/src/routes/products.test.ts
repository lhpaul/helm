import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { _resetForTests } from '../services/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HELM_PRODUCT = {
  helm_version: '0',
  product: { slug: 'helm', name: 'Helm' },
  workflow: { stages_enabled: ['discovery', 'released'], designer_gate: 'skip', qa_gate: 'skip' },
};

const PLAYGROUND_PRODUCT = {
  helm_version: '0',
  product: { slug: 'helm-playground', name: 'Helm Playground' },
  workflow: { stages_enabled: ['discovery', 'released'], designer_gate: 'skip', qa_gate: 'skip' },
};

const HELM_ITEMS = [
  {
    externalId: 'issue_1',
    productSlug: 'helm',
    currentStage: 'discovery',
    history: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    externalId: 'issue_2',
    productSlug: 'helm',
    currentStage: 'released',
    history: [],
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
];

const PLAYGROUND_ITEMS = [
  {
    externalId: 'issue_10',
    productSlug: 'helm-playground',
    currentStage: 'discovery',
    history: [],
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
  },
];

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetProductRegistry, mockList, mockGet } = vi.hoisted(() => ({
  mockGetProductRegistry: vi.fn(),
  mockList: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('../services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/index.js')>();
  return {
    ...real,
    getProductRegistry: mockGetProductRegistry,
    getItemStore: vi.fn().mockResolvedValue({ list: mockList, get: mockGet }),
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/products', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/products', () => {
    it('returns all registered products', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT, PLAYGROUND_PRODUCT]);
      const res = await app.request('/api/products');
      expect(res.status).toBe(200);
      const body = (await res.json()) as (typeof HELM_PRODUCT)[];
      expect(body).toHaveLength(2);
      expect(body.map((p) => p.product.slug).sort()).toEqual(['helm', 'helm-playground']);
    });

    it('returns 500 when registry loading fails', async () => {
      mockGetProductRegistry.mockRejectedValue(new Error('disk error'));
      const res = await app.request('/api/products');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/products/:slug', () => {
    it('returns 400 for invalid slug format', async () => {
      const res = await app.request('/api/products/INVALID_SLUG!');
      expect(res.status).toBe(400);
    });

    it('returns the matching product', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT, PLAYGROUND_PRODUCT]);
      const res = await app.request('/api/products/helm-playground');
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof PLAYGROUND_PRODUCT;
      expect(body.product.slug).toBe('helm-playground');
    });

    it('returns 404 for unknown slug', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      const res = await app.request('/api/products/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns 500 when registry loading fails', async () => {
      mockGetProductRegistry.mockRejectedValue(new Error('disk error'));
      const res = await app.request('/api/products/helm');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/products/:slug/items', () => {
    it('returns only items belonging to the requested product', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT, PLAYGROUND_PRODUCT]);
      mockList.mockResolvedValue([...HELM_ITEMS, ...PLAYGROUND_ITEMS]);

      const res = await app.request('/api/products/helm/items');
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof HELM_ITEMS;
      expect(body).toHaveLength(2);
      expect(body.every((i) => i.productSlug === 'helm')).toBe(true);
    });

    it('returns only playground items when requesting helm-playground', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT, PLAYGROUND_PRODUCT]);
      mockList.mockResolvedValue([...HELM_ITEMS, ...PLAYGROUND_ITEMS]);

      const res = await app.request('/api/products/helm-playground/items');
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof PLAYGROUND_ITEMS;
      expect(body).toHaveLength(1);
      expect(body[0]!.externalId).toBe('issue_10');
    });

    it('returns empty array when the product has no items', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT, PLAYGROUND_PRODUCT]);
      mockList.mockResolvedValue(HELM_ITEMS);

      const res = await app.request('/api/products/helm-playground/items');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('returns 400 for invalid slug format', async () => {
      const res = await app.request('/api/products/BAD_SLUG!/items');
      expect(res.status).toBe(400);
    });

    it('returns 404 when the product slug does not exist', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      const res = await app.request('/api/products/ghost/items');
      expect(res.status).toBe(404);
    });

    it('returns 500 when item store fails', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      mockList.mockRejectedValue(new Error('disk error'));
      const res = await app.request('/api/products/helm/items');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/products/:slug/items/:externalId', () => {
    const ITEM = {
      externalId: 'issue_1',
      productSlug: 'helm',
      currentStage: 'discovery',
      history: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('returns the item when product and item both exist and match', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      mockGet.mockResolvedValue(ITEM);

      const res = await app.request('/api/products/helm/items/issue_1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof ITEM;
      expect(body.externalId).toBe('issue_1');
      expect(body.currentStage).toBe('discovery');
    });

    it('returns 400 for invalid slug format', async () => {
      const res = await app.request('/api/products/BAD_SLUG!/items/issue_1');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid externalId characters', async () => {
      const res = await app.request('/api/products/helm/items/HLM:invalid');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Invalid request params');
    });

    it('rejects dot-segment externalIds', async () => {
      // Hono normalizes '.' and '..' URL segments before the handler runs, so
      // these requests reach 404 (no route match) rather than 400 at the handler.
      // ProductItemParamsSchema provides defense-in-depth for any non-HTTP path.
      // EXTERNAL_ID_REGEX also already rejects both via its (?!\.) lookahead.
      const resDot = await app.request('/api/products/helm/items/.');
      expect(resDot.status).not.toBe(200);

      const resDotDot = await app.request('/api/products/helm/items/..');
      expect(resDotDot.status).not.toBe(200);
    });

    it('returns 404 when product slug does not exist', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      mockGet.mockResolvedValue(ITEM);

      const res = await app.request('/api/products/ghost/items/issue_1');
      expect(res.status).toBe(404);
    });

    it('returns 404 when item does not exist', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      mockGet.mockResolvedValue(null);

      const res = await app.request('/api/products/helm/items/issue_999');
      expect(res.status).toBe(404);
    });

    it('returns 404 when item belongs to a different product (cross-product leak protection)', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT, PLAYGROUND_PRODUCT]);
      // issue_1 belongs to helm-playground, not helm
      mockGet.mockResolvedValue({ ...ITEM, productSlug: 'helm-playground' });

      const res = await app.request('/api/products/helm/items/issue_1');
      expect(res.status).toBe(404);
    });

    it('returns 500 when store throws', async () => {
      mockGetProductRegistry.mockResolvedValue([HELM_PRODUCT]);
      mockGet.mockRejectedValue(new Error('disk error'));

      const res = await app.request('/api/products/helm/items/issue_1');
      expect(res.status).toBe(500);
    });
  });
});
