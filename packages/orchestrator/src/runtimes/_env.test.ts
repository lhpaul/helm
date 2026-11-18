import { afterEach, describe, expect, it } from 'vitest';
import { API_SECRET_KEYS, SECRET_ENV_KEY_PATTERN, buildSubprocessEnv } from './_env.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('SECRET_ENV_KEY_PATTERN', () => {
  it.each([
    'GITHUB_TOKEN',
    'API_KEY',
    'MY_API_KEY',
    'DATABASE_URL',
    'PRIVATE_KEY',
    'AUTH_SECRET',
    'AWS_SECRET_ACCESS_KEY',
    'STRIPE_SECRET_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ])('matches credential-like key %s', (key) => {
    expect(SECRET_ENV_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(['NODE_ENV', 'PATH', 'HOME', 'LANG', 'HELM_DATA_DIR', 'SAFE_FLAG'])(
    'does not match non-secret key %s',
    (key) => {
      expect(SECRET_ENV_KEY_PATTERN.test(key)).toBe(false);
    },
  );
});

describe('buildSubprocessEnv', () => {
  it('scrubs explicit API secret keys and credential suffixes from process.env', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_x';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws_x';
    process.env['STRIPE_SECRET_KEY'] = 'stripe_x';
    process.env['GOOGLE_APPLICATION_CREDENTIALS'] = '/tmp/creds.json';
    process.env['NODE_ENV'] = 'test';
    process.env['PATH'] = '/usr/bin';

    const env = buildSubprocessEnv();

    for (const key of API_SECRET_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['STRIPE_SECRET_KEY']).toBeUndefined();
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
    expect(env['NODE_ENV']).toBe('test');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('scrubs credential-like keys reintroduced via extra env', () => {
    const env = buildSubprocessEnv({
      AWS_SECRET_ACCESS_KEY: 'injected',
      STRIPE_SECRET_KEY: 'injected',
      GOOGLE_APPLICATION_CREDENTIALS: 'injected',
      SAFE_FLAG: '1',
    });

    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['STRIPE_SECRET_KEY']).toBeUndefined();
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
    expect(env['SAFE_FLAG']).toBe('1');
  });
});
