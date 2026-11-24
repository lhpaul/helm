import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  MIN_TOKEN_LENGTH,
  apiAuth,
  isProtectedPath,
  parseBearerToken,
  resolveApiAuth,
  tokensMatch,
  type ApiAuthMode,
} from './api-auth.js';
import { WEBHOOK_PATHS, originGuard, resolveAllowedOrigins } from './origin-guard.js';

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));
vi.mock('hono/utils/buffer', async (importOriginal) => {
  const real = await importOriginal<typeof import('hono/utils/buffer')>();
  timingSafeEqualSpy.mockImplementation(real.timingSafeEqual);
  return { ...real, timingSafeEqual: timingSafeEqualSpy };
});

const TOKEN = 'a'.repeat(16) + 'B'.repeat(16) + '-unit-test-token';
const SECRET_LOOKING = 'S3cr3t-'.repeat(6);

describe('resolveApiAuth', () => {
  it('uses a valid HELM_API_TOKEN (trimmed)', () => {
    const config = resolveApiAuth({ HELM_API_TOKEN: `  ${TOKEN}  ` });
    expect(config).toEqual({ mode: 'token', token: TOKEN, errors: [], warnings: [] });
  });

  it('accepts exactly 32 characters', () => {
    const token = 'x'.repeat(MIN_TOKEN_LENGTH);
    expect(MIN_TOKEN_LENGTH).toBe(32);
    expect(resolveApiAuth({ HELM_API_TOKEN: token }).mode).toBe('token');
  });

  it.each([
    ['unset', {}],
    ['empty', { HELM_API_TOKEN: '' }],
    ['whitespace', { HELM_API_TOKEN: '   \t ' }],
  ])('fails closed when HELM_API_TOKEN is %s', (_label, env) => {
    const config = resolveApiAuth(env);
    expect(config.mode).toBe('misconfigured');
    expect(config.errors).toHaveLength(1);
    expect(config.errors[0]).toContain('HELM_API_TOKEN is not set');
  });

  it('fails closed when HELM_API_TOKEN is shorter than 32 characters', () => {
    const short = 'y'.repeat(MIN_TOKEN_LENGTH - 1);
    const config = resolveApiAuth({ HELM_API_TOKEN: short });
    expect(config.mode).toBe('misconfigured');
    expect(config.errors[0]).toContain('HELM_API_TOKEN is shorter than 32 characters');
    expect(config.errors.join('\n')).not.toContain(short);
  });

  it.each(['disabled', 'DISABLED', ' Disabled '])(
    'turns auth off with HELM_API_AUTH=%j and warns',
    (value) => {
      const config = resolveApiAuth({ HELM_API_AUTH: value, HELM_API_TOKEN: SECRET_LOOKING });
      expect(config.mode).toBe('disabled');
      expect(config.errors).toEqual([]);
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain('UNAUTHENTICATED');
      expect(config.warnings[0]).toContain('/api/webhooks/*');
      expect(config.warnings[0]).toContain('HELM_API_HOST');
    },
  );

  it('disables auth even without a token', () => {
    expect(resolveApiAuth({ HELM_API_AUTH: 'disabled' }).mode).toBe('disabled');
  });

  it.each(['off', 'false', '0', 'disable', 'disabled!'])(
    'ignores HELM_API_AUTH=%j with a warning and keeps auth on',
    (value) => {
      const withToken = resolveApiAuth({ HELM_API_AUTH: value, HELM_API_TOKEN: TOKEN });
      expect(withToken.mode).toBe('token');
      expect(withToken.warnings).toHaveLength(1);
      expect(withToken.warnings[0]).toContain('Ignoring HELM_API_AUTH');

      const withoutToken = resolveApiAuth({ HELM_API_AUTH: value });
      expect(withoutToken.mode).toBe('misconfigured');
      expect(withoutToken.warnings).toHaveLength(1);
    },
  );

  it('treats a blank HELM_API_AUTH as unset', () => {
    expect(resolveApiAuth({ HELM_API_AUTH: '  ', HELM_API_TOKEN: TOKEN }).warnings).toEqual([]);
  });

  it('never includes the token in errors or warnings', () => {
    const configs = [
      resolveApiAuth({ HELM_API_TOKEN: SECRET_LOOKING }),
      resolveApiAuth({ HELM_API_TOKEN: SECRET_LOOKING, HELM_API_AUTH: 'off' }),
      resolveApiAuth({ HELM_API_TOKEN: SECRET_LOOKING, HELM_API_AUTH: 'disabled' }),
      resolveApiAuth({ HELM_API_TOKEN: 'short-secret' }),
    ];
    for (const { errors, warnings } of configs) {
      const text = [...errors, ...warnings].join('\n');
      expect(text).not.toContain(SECRET_LOOKING);
      expect(text).not.toContain('short-secret');
    }
  });
});

describe('isProtectedPath', () => {
  it('exempts exactly the registered signed webhooks', () => {
    expect([...WEBHOOK_PATHS]).toEqual(['/api/webhooks/github', '/api/webhooks/linear']);
    for (const path of WEBHOOK_PATHS) expect(isProtectedPath(path)).toBe(false);
  });

  it.each([
    '/ws',
    '/api',
    '/api/',
    '/api/products',
    '/api/items',
    '/api/jobs/job_1',
    '/api/products/p/items/issue_1/dispatch',
    '/api/webhooks',
    '/api/webhooks/',
    '/api/webhooks/unknown',
    '/api/webhooks/github/',
    '/api/webhooks/github/extra',
  ])('protects %s', (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(['/health', '/', '/apiary', '/wsx', '/ws/'])('does not match %s', (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });
});

describe('parseBearerToken', () => {
  it.each([
    [`Bearer ${TOKEN}`, TOKEN],
    [`bearer ${TOKEN}`, TOKEN],
    [`BEARER\t${TOKEN}`, TOKEN],
    [`  Bearer   ${TOKEN}  `, TOKEN],
  ])('parses %j', (header, expected) => {
    expect(parseBearerToken(header)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    'Bearer',
    'Bearer ',
    TOKEN,
    `Basic ${TOKEN}`,
    `Bearer a b`,
    `Token ${TOKEN}`,
  ])('rejects %j', (header) => {
    expect(parseBearerToken(header)).toBeNull();
  });
});

describe('tokensMatch (constant time)', () => {
  beforeEach(() => timingSafeEqualSpy.mockClear());

  it('compares with Hono timingSafeEqual for equal and different lengths', async () => {
    expect(await tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(await tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(await tokensMatch('short', TOKEN)).toBe(false);
    expect(await tokensMatch(TOKEN.replace(/a$/, 'b').replace(/^a/, 'b'), TOKEN)).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(4);
    expect(timingSafeEqualSpy).toHaveBeenNthCalledWith(1, TOKEN, TOKEN);
    expect(timingSafeEqualSpy).toHaveBeenNthCalledWith(3, 'short', TOKEN);
  });
});

describe('apiAuth middleware', () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    timingSafeEqualSpy.mockClear();
  });
  afterEach(() => warnSpy.mockRestore());

  function makeApp(config: ApiAuthMode) {
    const handler = vi.fn((c: { json: (b: unknown) => Response }) => c.json({ ok: true }));
    const app = new Hono();
    const auth = apiAuth(config);
    app.use('/api/*', auth);
    app.use('/ws', auth);
    app.get('/api/things', handler);
    app.post('/api/things', handler);
    app.post('/api/webhooks/github', handler);
    app.post('/api/webhooks/linear', handler);
    app.post('/api/webhooks/other', handler);
    // Stand-in for the Bun upgrade handler registered in index.ts.
    app.get('/ws', handler);
    app.get('/health', handler);
    return { app, handler };
  }

  async function expectUnauthorized(res: Response) {
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  }

  const tokenConfig: ApiAuthMode = { mode: 'token', token: TOKEN };

  it.each([
    ['missing header', {}, ''],
    ['wrong token', { authorization: `Bearer ${'z'.repeat(TOKEN.length)}` }, ''],
    ['token of another length', { authorization: `Bearer ${TOKEN.slice(1)}` }, ''],
    ['Basic scheme', { authorization: `Basic ${TOKEN}` }, ''],
    ['query-string token', {}, `?token=${TOKEN}`],
    ['cookie token', { cookie: `token=${TOKEN}` }, ''],
    ['other header', { 'x-api-key': TOKEN, 'x-helm-token': TOKEN }, ''],
  ])('rejects %s on reads and writes without running the handler', async (_l, headers, q) => {
    const { app, handler } = makeApp(tokenConfig);
    await expectUnauthorized(await app.request(`/api/things${q}`, { headers }));
    await expectUnauthorized(
      await app.request(`/api/things${q}`, { method: 'POST', headers, body: '{}' }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([`Bearer ${TOKEN}`, `bearer ${TOKEN}`])('accepts %j', async (authorization) => {
    const { app, handler } = makeApp(tokenConfig);
    expect((await app.request('/api/things', { headers: { authorization } })).status).toBe(200);
    const post = await app.request('/api/things', {
      method: 'POST',
      headers: { authorization },
      body: '{}',
    });
    expect(post.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(timingSafeEqualSpy).toHaveBeenCalledWith(TOKEN, TOKEN);
  });

  it('protects /ws before the upgrade handler runs', async () => {
    const { app, handler } = makeApp(tokenConfig);
    await expectUnauthorized(await app.request('/ws', { headers: { upgrade: 'websocket' } }));
    await expectUnauthorized(await app.request(`/ws?token=${TOKEN}`));
    expect(handler).not.toHaveBeenCalled();
    const ok = await app.request('/ws', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
  });

  it('lets the registered webhooks and /health through without a token', async () => {
    const { app, handler } = makeApp(tokenConfig);
    expect((await app.request('/api/webhooks/github', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/webhooks/linear', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('protects an unregistered path under /api/webhooks/', async () => {
    const { app, handler } = makeApp(tokenConfig);
    await expectUnauthorized(await app.request('/api/webhooks/other', { method: 'POST' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when misconfigured, even with a header', async () => {
    const { app, handler } = makeApp({ mode: 'misconfigured' });
    await expectUnauthorized(await app.request('/api/things'));
    await expectUnauthorized(
      await app.request('/api/things', { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    await expectUnauthorized(await app.request('/ws'));
    expect(handler).not.toHaveBeenCalled();
    // Webhooks and /health keep working.
    expect((await app.request('/api/webhooks/github', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
  });

  it('lets everything through when disabled', async () => {
    const { app, handler } = makeApp({ mode: 'disabled' });
    expect((await app.request('/api/things')).status).toBe(200);
    expect((await app.request('/api/things', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/ws')).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('logs method and path only, never the received or configured token', async () => {
    const { app } = makeApp(tokenConfig);
    const received = `candidate-${'q'.repeat(40)}`;
    await app.request(`/api/things?token=${TOKEN}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${received}` },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]?.[0]);
    expect(line).toBe('[api-auth] Unauthorized POST "/api/things"');
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(received);
  });

  it('runs after the origin guard (#162)', async () => {
    const app = new Hono();
    app.use('/api/*', originGuard(resolveAllowedOrigins({}).origins));
    app.use('/api/*', apiAuth(tokenConfig));
    app.post('/api/things', (c) => c.json({ ok: true }));
    const foreign = await app.request('/api/things', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    const local = await app.request('/api/things', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://localhost:5173' },
    });
    expect(local.status).toBe(200);
  });
});
