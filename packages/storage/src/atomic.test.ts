import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJson, writeJsonAtomic } from './atomic.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `helm-atomic-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('creates file with correct serialized content', async () => {
    const path = join(testDir, 'meta.json');
    await writeJsonAtomic(path, { status: 'running', model: 'claude-sonnet-4-6' });

    const result = await readJson<{ status: string; model: string }>(path);
    expect(result).toEqual({ status: 'running', model: 'claude-sonnet-4-6' });
  });

  it('creates parent directories automatically', async () => {
    const path = join(testDir, 'nested', 'deep', 'meta.json');
    await writeJsonAtomic(path, { ok: true });

    expect(existsSync(path)).toBe(true);
  });

  it('leaves no orphaned .tmp file after successful write', async () => {
    const path = join(testDir, 'meta.json');
    await writeJsonAtomic(path, { ok: true });

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe('readJson', () => {
  it('returns null when file does not exist', async () => {
    const result = await readJson(join(testDir, 'non-existent.json'));
    expect(result).toBeNull();
  });

  it('throws on malformed JSON without swallowing the error', async () => {
    const path = join(testDir, 'bad.json');
    await writeFile(path, '{ invalid json }', 'utf-8');

    await expect(readJson(path)).rejects.toThrow(`Invalid JSON at "${path}"`);
  });
});
