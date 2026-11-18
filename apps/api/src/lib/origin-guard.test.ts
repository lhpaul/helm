import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALLOWED_ORIGINS,
  WEBHOOK_PATHS,
  checkOrigin,
  normalizeOrigin,
  originGuard,
  resolveAllowedOrigins,
} from './origin-guard.js';

const DISPATCH = '/api/products/p/items/issue_1/dispatch';
const defaults = resolveAllowedOrigins({}).origins;

describe('normalizeOrigin', () => {
  it.each([
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://LOCALHOST:5173/', 'http://localhost:5173'],
    ['https://helm.example.com:443', 'https://helm.example.com'],
    ['http://helm.example.com:80', 'http://helm.example.com'],
    ['  http://[::1]:5173  ', 'http://[::1]:5173'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'null',
    '*',
    'localhost:5173',
    'ftp://example.com',
    'file:///tmp/x',
    'http://example.com/path',
    'http://example.com/?q=1',
    'http://example.com/#x',
    'http://user:pass@example.com',
  ])('rejects %j', (input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });
});

describe('resolveAllowedOrigins', () => {
  it('allows the local UI dev server origins by default', () => {
    const { origins, warnings } = resolveAllowedOrigins({});
    expect([...origins]).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(origins.has('http://localhost:5173')).toBe(true);
    expect(origins.has('http://127.0.0.1:5173')).toBe(true);
    expect(origins.has('http://[::1]:5173')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('ignores a blank HELM_ALLOWED_ORIGINS', () => {
    expect(resolveAllowedOrigins({ HELM_ALLOWED_ORIGINS: ' , ,' })).toEqual(
      resolveAllowedOrigins({}),
    );
  });

  it('adds normalized HELM_ALLOWED_ORIGINS entries to the defaults', () => {
    const { origins, warnings } = resolveAllowedOrigins({
      HELM_ALLOWED_ORIGINS: ' https://Helm.Example.com/ , http://192.168.1.10:5173 ',
    });
    expect(origins.has('https://helm.example.com')).toBe(true);
    expect(origins.has('http://192.168.1.10:5173')).toBe(true);
    expect(origins.has('http://localhost:5173')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('skips invalid entries with a warning', () => {
    const { origins, warnings } = resolveAllowedOrigins({
      HELM_ALLOWED_ORIGINS: '*,https://ok.example.com,https://bad.example.com/path',
    });
    expect(origins.has('https://ok.example.com')).toBe(true);
    expect(origins.has('*')).toBe(false);
    expect(origins.size).toBe(DEFAULT_ALLOWED_ORIGINS.length + 1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"*"');
    expect(warnings[1]).toContain('"https://bad.example.com/path"');
  });
});

describe('checkOrigin', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('allows safe method %s from any origin', (method) => {
    expect(checkOrigin({ method, path: DISPATCH, origin: 'https://evil.example' }, defaults)).toBe(
      'allow',
    );
  });

  it.each([...WEBHOOK_PATHS])('allows webhook %s from any origin', (path) => {
    expect(
      checkOrigin(
        { method: 'POST', path, origin: 'https://evil.example', secFetchSite: 'cross-site' },
        defaults,
      ),
    ).toBe('allow');
  });

  it('does not treat other paths under /api/webhooks/ as webhooks', () => {
    expect(
      checkOrigin(
        { method: 'POST', path: '/api/webhooks/other', origin: 'https://evil.example' },
        defaults,
      ),
    ).toBe('reject');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects %s with a foreign Origin, even with Sec-Fetch-Site same-origin',
    (method) => {
      expect(
        checkOrigin(
          { method, path: DISPATCH, origin: 'https://evil.example', secFetchSite: 'same-origin' },
          defaults,
        ),
      ).toBe('reject');
    },
  );

  it.each([
    'null',
    '',
    'http://localhost:3000',
    'http://localhost:5174',
    'https://localhost:5173',
    'http://localhost.evil.example:5173',
  ])('rejects Origin %j', (origin) => {
    expect(checkOrigin({ method: 'POST', path: DISPATCH, origin }, defaults)).toBe('reject');
  });

  it('allows the default UI origins', () => {
    for (const origin of DEFAULT_ALLOWED_ORIGINS) {
      expect(checkOrigin({ method: 'POST', path: DISPATCH, origin }, defaults)).toBe('allow');
    }
  });

  it('allows an origin configured in HELM_ALLOWED_ORIGINS', () => {
    const { origins } = resolveAllowedOrigins({ HELM_ALLOWED_ORIGINS: 'https://helm.example.com' });
    expect(
      checkOrigin({ method: 'POST', path: DISPATCH, origin: 'https://helm.example.com' }, origins),
    ).toBe('allow');
    expect(
      checkOrigin({ method: 'POST', path: DISPATCH, origin: 'https://helm.example.com' }, defaults),
    ).toBe('reject');
  });

  it.each(['cross-site', 'same-site', 'CROSS-SITE', 'bogus'])(
    'rejects a request without Origin and Sec-Fetch-Site %s',
    (secFetchSite) => {
      expect(checkOrigin({ method: 'POST', path: DISPATCH, secFetchSite }, defaults)).toBe(
        'reject',
      );
    },
  );

  it.each(['same-origin', 'none'])(
    'allows a request without Origin and Sec-Fetch-Site %s',
    (secFetchSite) => {
      expect(checkOrigin({ method: 'POST', path: DISPATCH, secFetchSite }, defaults)).toBe('allow');
    },
  );

  it('allows a request with neither Origin nor Sec-Fetch-Site (curl, scripts)', () => {
    expect(checkOrigin({ method: 'POST', path: DISPATCH }, defaults)).toBe('allow');
    expect(
      checkOrigin({ method: 'POST', path: DISPATCH, origin: null, secFetchSite: null }, defaults),
    ).toBe('allow');
  });
});

describe('originGuard middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeApp = () => {
    const handler = vi.fn(() => new Response('ok'));
    const app = new Hono();
    app.use('/api/*', originGuard(defaults));
    app.post('/api/things', handler);
    app.get('/api/things', handler);
    app.post('/api/webhooks/github', handler);
    return { app, handler };
  };

  it('returns 403 without calling the handler for a foreign Origin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, handler } = makeApp();
    const res = await app.request('/api/things', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cross-origin request rejected' });
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[origin-guard] Rejected POST "/api/things" origin="https://evil.example"',
    );
  });

  it('returns 403 for a cross-site request without Origin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, handler } = makeApp();
    const res = await app.request('/api/things', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes allowed, header-less, safe and webhook requests to the handler', async () => {
    const { app, handler } = makeApp();
    const responses = await Promise.all([
      app.request('/api/things', {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
      }),
      app.request('/api/things', { method: 'POST' }),
      app.request('/api/things', { headers: { Origin: 'https://evil.example' } }),
      app.request('/api/webhooks/github', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(handler).toHaveBeenCalledTimes(4);
  });
});
