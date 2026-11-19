// @vitest-environment node
// vite.config.ts loads esbuild-backed plugins, which need a Node (not jsdom) environment.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'proxy-test-token-0123456789abcdef0123';

describe('vite.config token exposure', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the token in the proxy only, never in define or the client env', async () => {
    vi.stubEnv('HELM_API_TOKEN', TOKEN);
    vi.resetModules();
    // Runtime specifier: vite.config.ts is outside the typechecked src/ rootDir.
    const configModule = '../../vite.config';
    const { default: config } = (await import(/* @vite-ignore */ configModule)) as {
      default: UserConfig;
    };
    expect(config.define).toBeUndefined();
    expect(config.envPrefix).toBeUndefined(); // default VITE_ only
    const proxy = config.server?.proxy as Record<string, { headers?: Record<string, string> }>;
    expect(proxy['/api']?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(proxy['/ws']?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    // What Vite would expose to the client bundle (VITE_-prefixed only).
    // An empty envDir so the check reads process.env only, never a local .env file.
    const { loadEnv } = await import('vite');
    const envDir = await mkdtemp(join(tmpdir(), 'helm-vite-env-'));
    const clientEnv = loadEnv('development', envDir, config.envPrefix);
    await rm(envDir, { recursive: true, force: true });
    expect(clientEnv.HELM_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(clientEnv)).not.toContain(TOKEN);
  });
});
