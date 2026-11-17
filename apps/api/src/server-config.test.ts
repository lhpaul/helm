import { describe, expect, it } from 'vitest';
import {
  API_PORT,
  DEFAULT_API_HOST,
  buildListenConfig,
  formatListenUrl,
  isLoopbackHost,
  resolveApiHost,
} from './server-config.js';

describe('resolveApiHost', () => {
  it('defaults to 127.0.0.1 when HELM_API_HOST is not set', () => {
    expect(DEFAULT_API_HOST).toBe('127.0.0.1');
    expect(resolveApiHost({})).toBe('127.0.0.1');
  });

  it('falls back to the default for empty or blank values', () => {
    expect(resolveApiHost({ HELM_API_HOST: '' })).toBe('127.0.0.1');
    expect(resolveApiHost({ HELM_API_HOST: '   ' })).toBe('127.0.0.1');
  });

  it('uses the trimmed override when set', () => {
    expect(resolveApiHost({ HELM_API_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveApiHost({ HELM_API_HOST: ' 192.168.1.10 ' })).toBe('192.168.1.10');
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '127.0.0',
    '127.0.0.256',
    '127.evil.com',
    'example.com',
  ])('treats %s as non-loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('buildListenConfig', () => {
  it('binds to loopback on port 3001 by default, without warning', () => {
    expect(buildListenConfig({})).toEqual({ hostname: '127.0.0.1', port: API_PORT });
    expect(API_PORT).toBe(3001);
  });

  it('does not warn for a loopback override', () => {
    expect(buildListenConfig({ HELM_API_HOST: '::1' })).toEqual({ hostname: '::1', port: 3001 });
  });

  it('warns when the override exposes the API beyond loopback', () => {
    const config = buildListenConfig({ HELM_API_HOST: '0.0.0.0' });
    expect(config.hostname).toBe('0.0.0.0');
    expect(config.port).toBe(3001);
    expect(config.warning).toMatch(/HELM_API_HOST=0\.0\.0\.0/);
    expect(config.warning).toMatch(/no authentication/);
  });
});

describe('formatListenUrl', () => {
  it('formats IPv4 and IPv6 hosts', () => {
    expect(formatListenUrl({ hostname: '127.0.0.1', port: 3001 })).toBe('http://127.0.0.1:3001');
    expect(formatListenUrl({ hostname: '::1', port: 3001 })).toBe('http://[::1]:3001');
  });
});
