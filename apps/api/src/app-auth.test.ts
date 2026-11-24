// API authentication through the real app (#160, ADR-045): auth on with the
// test token from test-setup.ts, the #162 origin guard first, webhooks and
// /health exempt.
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { app } from './app.js';
import { _resetForTests, getJobStore } from './services/index.js';
import { TEST_API_TOKEN, TEST_AUTH_HEADER } from './test-support/operator-token.js';

const { mockSetSubStage, mockEnsureSubStages } = vi.hoisted(() => ({
  mockSetSubStage: vi.fn().mockResolvedValue(undefined),
  mockEnsureSubStages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./services/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/index.js')>();
  return {
    ...real,
    getIssueTrackerAdapter: vi
      .fn()
      .mockResolvedValue({ setSubStage: mockSetSubStage, ensureSubStages: mockEnsureSubStages }),
  };
});

const PRODUCT_YAML = `
helm_version: "0"
product:
  slug: example-app
  name: Example App
issue_tracker:
  provider: github_projects
  org: example-org
  project_number: 42
code_repos:
  - url: https://github.com/example-org/example-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/example-org/example-app-knowledge
  default_branch: main
workflow:
  stages_enabled: [in-development, released]
specialists:
  'spec-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'plan-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  'code-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'security-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'test-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  spec-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  code-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

const WEBHOOK_SECRET = 'test-auth-webhook-secret';
const DISPATCH = '/api/products/example-app/items/HLM-1/dispatch';
const ENV_KEYS = [
  'HELM_DATA_DIR',
  'HELM_KNOWLEDGE_REPO_PATH',
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
] as const;

let testDir: string;
let savedEnv: Record<string, string | undefined>;
let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(async () => {
  _resetForTests();
  mockSetSubStage.mockClear();
  mockEnsureSubStages.mockClear();
  testDir = join(tmpdir(), `helm-app-auth-${randomUUID()}`);
  await mkdir(join(testDir, 'data'), { recursive: true });
  await mkdir(join(testDir, 'knowledge', '.helm'), { recursive: true });
  await writeFile(join(testDir, 'knowledge', '.helm', 'product.yaml'), PRODUCT_YAML);
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HELM_DATA_DIR = join(testDir, 'data');
  process.env.HELM_KNOWLEDGE_REPO_PATH = join(testDir, 'knowledge');
  process.env.GITHUB_TOKEN = 'test-github-token';
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  _resetForTests();
  await rm(testDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const json = { 'Content-Type': 'application/json' };
const createItemBody = JSON.stringify({ externalId: 'HLM-1', triggeredBy: 'human:test' });

/** Every rejected credential shape from AC 1. */
const BAD_CREDENTIALS: Array<[string, Record<string, string>, string]> = [
  ['no Authorization header', {}, ''],
  [
    'a wrong token of the same length',
    { authorization: `Bearer ${'x'.repeat(TEST_API_TOKEN.length)}` },
    '',
  ],
  ['a token of a different length', { authorization: `Bearer ${TEST_API_TOKEN}extra` }, ''],
  [
    'a Basic scheme',
    { authorization: `Basic ${Buffer.from(`op:${TEST_API_TOKEN}`).toString('base64')}` },
    '',
  ],
  ['the raw token without scheme', { authorization: TEST_API_TOKEN }, ''],
  [
    'the token only in the query string',
    {},
    `?token=${TEST_API_TOKEN}&access_token=${TEST_API_TOKEN}`,
  ],
  ['the token only in a cookie', { cookie: `helm_token=${TEST_API_TOKEN}` }, ''],
];

async function expectUnauthorized(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
}

async function listItems(): Promise<unknown[]> {
  const res = await app.request('/api/items', { headers: { authorization: TEST_AUTH_HEADER } });
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
}

describe('API auth on writes (AC 1)', () => {
  it.each(BAD_CREDENTIALS)(
    'POST /api/items with %s → 401, no item written',
    async (_label, headers, query) => {
      const res = await app.request(`/api/items${query}`, {
        method: 'POST',
        headers: { ...json, ...headers },
        body: createItemBody,
      });
      await expectUnauthorized(res);
      expect(await listItems()).toEqual([]);
      expect(mockSetSubStage).not.toHaveBeenCalled();
    },
  );

  it.each(BAD_CREDENTIALS)(
    'POST dispatch with %s → 401, no dispatch job',
    async (_label, headers, query) => {
      const created = await app.request('/api/items', {
        method: 'POST',
        headers: { ...json, authorization: TEST_AUTH_HEADER },
        body: createItemBody,
      });
      expect(created.status).toBe(201);
      const res = await app.request(`${DISPATCH}${query}`, {
        method: 'POST',
        headers: { ...json, ...headers },
        body: JSON.stringify({ specialistId: 'spec-writer' }),
      });
      await expectUnauthorized(res);
      const store = await getJobStore();
      expect(await store.listJobsForItem('example-app', 'HLM-1')).toEqual([]);
    },
  );
});

describe('API auth on reads (AC 2)', () => {
  it.each(['/api/products', '/api/items', '/api/product', '/api/jobs/job_00000000'])(
    'GET %s without a valid token → 401',
    async (path) => {
      await expectUnauthorized(await app.request(path));
      await expectUnauthorized(
        await app.request(path, { headers: { authorization: 'Bearer wrong' } }),
      );
    },
  );

  it('GET /api/products with the token → 200', async () => {
    const res = await app.request('/api/products', {
      headers: { authorization: TEST_AUTH_HEADER },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/jobs/:jobId with the token reaches the handler', async () => {
    const res = await app.request('/api/jobs/unknown-job', {
      headers: { authorization: TEST_AUTH_HEADER },
    });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('valid token accepted (AC 3)', () => {
  it.each([TEST_AUTH_HEADER, `bearer ${TEST_API_TOKEN}`, `BEARER   ${TEST_API_TOKEN}  `])(
    'POST /api/items with %j reaches the handler',
    async (authorization) => {
      const res = await app.request('/api/items', {
        method: 'POST',
        headers: { ...json, authorization },
        body: createItemBody,
      });
      expect(res.status).toBe(201);
      expect(await listItems()).toHaveLength(1);
    },
  );

  it('dispatch with the token reaches the handler', async () => {
    const res = await app.request(DISPATCH, {
      method: 'POST',
      headers: { ...json, authorization: TEST_AUTH_HEADER },
      body: JSON.stringify({ specialistId: 'spec-writer' }),
    });
    // The item does not exist: the dispatch handler answers, not the auth layer.
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('exemptions (AC 5)', () => {
  const signedPing = (body: string, signature?: string) =>
    app.request('/api/webhooks/github', {
      method: 'POST',
      headers: {
        ...json,
        'x-github-event': 'ping',
        'x-github-delivery': 'auth-test',
        ...(signature !== undefined ? { 'x-hub-signature-256': signature } : {}),
      },
      body,
    });

  it('accepts a signed GitHub webhook without Authorization', async () => {
    const body = JSON.stringify({ zen: 'hi' });
    const sig = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    const res = await signedPing(body, sig);
    expect(res.status).toBe(200);
  });

  it('still rejects a bad GitHub signature through its own check', async () => {
    const res = await signedPing('{}', 'sha256=' + 'a'.repeat(64));
    expect(res.status).toBe(401);
    // The webhook's own 401 (no body), not the operator-token 401.
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('does not ask the Linear webhook for the token', async () => {
    const res = await app.request('/api/webhooks/linear', { method: 'POST', body: '{}' });
    // This product is not a Linear product: the webhook handler answers.
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(res.status).not.toBe(401);
  });

  it('GET /health answers 200 without a header', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it.each(['/api/webhooks/unknown', '/api/webhooks/github/', '/api/webhooks', '/api'])(
    'an unregistered path %s without a token → 401',
    async (path) => {
      await expectUnauthorized(await app.request(path, { method: 'POST', body: '{}' }));
    },
  );
});

describe('origin guard order (AC 8)', () => {
  it('rejects a foreign Origin with 403 even with a valid token', async () => {
    const res = await app.request('/api/items', {
      method: 'POST',
      headers: { ...json, authorization: TEST_AUTH_HEADER, origin: 'https://evil.example' },
      body: createItemBody,
    });
    expect(res.status).toBe(403);
    expect(await listItems()).toEqual([]);
  });

  it.each<Record<string, string>>([{ origin: 'http://localhost:5173' }, {}])(
    'passes both guards with a valid token and Origin %j',
    async (originHeader) => {
      const res = await app.request('/api/items', {
        method: 'POST',
        headers: { ...json, authorization: TEST_AUTH_HEADER, ...originHeader },
        body: createItemBody,
      });
      expect(res.status).toBe(201);
    },
  );
});

describe('no token leakage (AC 9)', () => {
  it('never logs or returns the received or configured token', async () => {
    const wrong = `Bearer leaked-candidate-${'z'.repeat(40)}`;
    const res = await app.request(`/api/items?token=${TEST_API_TOKEN}`, {
      method: 'POST',
      headers: { ...json, authorization: wrong },
      body: createItemBody,
    });
    const text = await res.text();
    expect(text).not.toContain(TEST_API_TOKEN);
    expect(text).not.toContain('leaked-candidate');
    const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
    expect(logged).toContain('[api-auth] Unauthorized POST "/api/items"');
    expect(logged).not.toContain(TEST_API_TOKEN);
    expect(logged).not.toContain('leaked-candidate');
  });
});

describe('startup configuration through a fresh app (AC 6, 7)', () => {
  async function bootApp(env: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
    vi.resetModules();
    const mod = await import('./app.js');
    return mod.app;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const loggedText = () =>
    [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');

  async function signedPing(fresh: typeof app) {
    const body = JSON.stringify({ zen: 'hi' });
    const sig = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    return fresh.request('/api/webhooks/github', {
      method: 'POST',
      headers: { ...json, 'x-github-event': 'ping', 'x-hub-signature-256': sig },
      body,
    });
  }

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '    '],
    ['31 characters', 'k'.repeat(31)],
  ])('fails closed when HELM_API_TOKEN is %s', async (_label, value) => {
    const env: Record<string, string | undefined> = { HELM_API_AUTH: '' };
    if (value === undefined) {
      vi.stubEnv('HELM_API_TOKEN', '');
      delete process.env.HELM_API_TOKEN;
    } else {
      env.HELM_API_TOKEN = value;
    }
    const fresh = await bootApp(env);
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain('HELM_API_TOKEN');
    await expectUnauthorized(await fresh.request('/api/products'));
    await expectUnauthorized(
      await fresh.request('/api/items', {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${value ?? ''}` },
        body: createItemBody,
      }),
    );
    expect((await fresh.request('/health')).status).toBe(200);
    expect((await signedPing(fresh)).status).toBe(200);
    if (value) expect(loggedText()).not.toContain(value);
  });

  it.each(['disabled', 'DISABLED'])(
    'HELM_API_AUTH=%s serves protected routes without a token and warns',
    async (value) => {
      const fresh = await bootApp({ HELM_API_AUTH: value });
      expect(warnSpy.mock.calls.flat().map(String).join('\n')).toContain('UNAUTHENTICATED');
      expect((await fresh.request('/api/products')).status).toBe(200);
      const res = await fresh.request('/api/items', {
        method: 'POST',
        headers: json,
        body: createItemBody,
      });
      expect(res.status).toBe(201);
      expect(loggedText()).not.toContain(TEST_API_TOKEN);
    },
  );

  it.each(['off', 'false'])('HELM_API_AUTH=%s keeps auth on and warns', async (value) => {
    const fresh = await bootApp({ HELM_API_AUTH: value });
    expect(warnSpy.mock.calls.flat().map(String).join('\n')).toContain('Ignoring HELM_API_AUTH');
    await expectUnauthorized(await fresh.request('/api/products'));
    const ok = await fresh.request('/api/products', {
      headers: { authorization: TEST_AUTH_HEADER },
    });
    expect(ok.status).toBe(200);
  });
});
