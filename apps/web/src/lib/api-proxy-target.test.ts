import { describe, expect, it } from 'vitest';
import {
  apiProxyAuthHeaders,
  apiProxyConfig,
  apiProxyTargets,
  resolveApiProxyHost,
} from './api-proxy-target';

describe('resolveApiProxyHost', () => {
  it('targets 127.0.0.1 when HELM_API_HOST is unset or blank', () => {
    expect(resolveApiProxyHost({})).toBe('127.0.0.1');
    expect(resolveApiProxyHost({ HELM_API_HOST: '  ' })).toBe('127.0.0.1');
  });

  it('reaches wildcard binds over loopback', () => {
    expect(resolveApiProxyHost({ HELM_API_HOST: '0.0.0.0' })).toBe('127.0.0.1');
    expect(resolveApiProxyHost({ HELM_API_HOST: '::' })).toBe('[::1]');
  });

  it('follows a specific bind address', () => {
    expect(resolveApiProxyHost({ HELM_API_HOST: ' 192.168.1.10 ' })).toBe('192.168.1.10');
    expect(resolveApiProxyHost({ HELM_API_HOST: '::1' })).toBe('[::1]');
    expect(resolveApiProxyHost({ HELM_API_HOST: 'localhost' })).toBe('localhost');
  });
});

describe('apiProxyTargets', () => {
  it('builds http and ws targets on port 3001', () => {
    expect(apiProxyTargets({})).toEqual({
      http: 'http://127.0.0.1:3001',
      ws: 'ws://127.0.0.1:3001',
    });
    expect(apiProxyTargets({ HELM_API_HOST: '::1' })).toEqual({
      http: 'http://[::1]:3001',
      ws: 'ws://[::1]:3001',
    });
  });
});

const TOKEN = 'proxy-test-token-0123456789abcdef0123';

describe('apiProxyAuthHeaders', () => {
  it('returns a Bearer header when HELM_API_TOKEN is set (trimmed)', () => {
    expect(apiProxyAuthHeaders({ HELM_API_TOKEN: `  ${TOKEN} ` })).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it.each([{}, { HELM_API_TOKEN: '' }, { HELM_API_TOKEN: '   ' }])(
    'returns no header for %j',
    (env) => {
      expect(apiProxyAuthHeaders(env)).toBeUndefined();
    },
  );

  it('ignores a VITE_-prefixed token', () => {
    expect(apiProxyAuthHeaders({ VITE_HELM_API_TOKEN: TOKEN })).toBeUndefined();
  });
});

describe('apiProxyConfig', () => {
  it('adds the header to /api and /ws when HELM_API_TOKEN is set', () => {
    expect(apiProxyConfig({ HELM_API_TOKEN: TOKEN })).toEqual({
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    });
  });

  it.each([{}, { HELM_API_TOKEN: '  ' }])('adds no header for %j', (env) => {
    const config = apiProxyConfig(env);
    expect(config['/api']).toEqual({ target: 'http://127.0.0.1:3001', changeOrigin: true });
    expect(config['/ws']).toEqual({ target: 'ws://127.0.0.1:3001', ws: true });
    expect('headers' in config['/api']).toBe(false);
    expect('headers' in config['/ws']).toBe(false);
  });

  it('follows HELM_API_HOST', () => {
    const config = apiProxyConfig({ HELM_API_HOST: '::1', HELM_API_TOKEN: TOKEN });
    expect(config['/api'].target).toBe('http://[::1]:3001');
    expect(config['/ws'].target).toBe('ws://[::1]:3001');
  });
});
