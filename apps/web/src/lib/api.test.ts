import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockErr(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    statusText: `Error ${status}`,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => vi.clearAllMocks());

describe('api.getProduct', () => {
  it('returns ok result on success', async () => {
    const product = { helm_version: '0', product: { slug: 'helm', name: 'Helm' } };
    mockFetch.mockResolvedValueOnce(mockOk(product));
    const result = await api.getProduct();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.product.slug).toBe('helm');
  });

  it('returns http error on non-200', async () => {
    mockFetch.mockResolvedValueOnce(mockErr(404, { error: 'Not found' }));
    const result = await api.getProduct();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('http');
      expect((result.error as { status: number }).status).toBe(404);
    }
  });

  it('returns network error on fetch throw', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));
    const result = await api.getProduct();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('network');
      expect(result.error.message).toBe('Failed to fetch');
    }
  });
});

describe('api.listItems', () => {
  it('returns array of items', async () => {
    const items = [{ externalId: 'issue_1', currentStage: 'discovery' }];
    mockFetch.mockResolvedValueOnce(mockOk(items));
    const result = await api.listItems();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
  });
});

describe('api.getItem', () => {
  it('URL-encodes special characters in externalId', async () => {
    const externalId = 'issue/1 with space';
    mockFetch.mockResolvedValueOnce(mockOk({ externalId }));
    await api.getItem(externalId);
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain(encodeURIComponent(externalId));
  });

  it('returns http error on 404', async () => {
    mockFetch.mockResolvedValueOnce(mockErr(404, { error: 'Not found' }));
    const result = await api.getItem('issue_999');
    expect(result.ok).toBe(false);
  });
});

describe('api.listProducts', () => {
  it('returns array of products', async () => {
    const products = [
      { product: { slug: 'helm', name: 'Helm' } },
      { product: { slug: 'helm-playground', name: 'Helm Playground' } },
    ];
    mockFetch.mockResolvedValueOnce(mockOk(products));
    const result = await api.listProducts();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(2);
  });

  it('returns network error on fetch throw', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));
    const result = await api.listProducts();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('network');
  });
});

describe('api.getProductBySlug', () => {
  it('URL-encodes the slug', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ product: { slug: 'helm' } }));
    await api.getProductBySlug('helm');
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/products/helm');
  });

  it('returns http error on 404', async () => {
    mockFetch.mockResolvedValueOnce(mockErr(404, { error: 'Product not found: ghost' }));
    const result = await api.getProductBySlug('ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as { status: number }).status).toBe(404);
  });
});

describe('api.listItemsForProduct', () => {
  it('fetches from the product-scoped items endpoint', async () => {
    const items = [{ externalId: 'issue_1', productSlug: 'helm-playground' }];
    mockFetch.mockResolvedValueOnce(mockOk(items));
    const result = await api.listItemsForProduct('helm-playground');
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/products/helm-playground/items');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
  });

  it('returns empty array when product has no items', async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const result = await api.listItemsForProduct('new-product');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(0);
  });
});
