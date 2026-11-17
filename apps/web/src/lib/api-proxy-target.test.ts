import { describe, expect, it } from 'vitest';
import { apiProxyTargets, resolveApiProxyHost } from './api-proxy-target';

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
