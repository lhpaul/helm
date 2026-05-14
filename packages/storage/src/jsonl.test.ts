import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJsonl, readJsonl } from './jsonl.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `helm-jsonl-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('appendJsonl / readJsonl', () => {
  it('appendJsonl creates file on first write and readJsonl parses it', async () => {
    const path = join(testDir, 'costs.jsonl');
    await appendJsonl(path, { usd: 0.01, model: 'claude-sonnet-4-6' });

    const entries = await readJsonl<{ usd: number; model: string }>(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.usd).toBe(0.01);
    expect(entries[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('preserves insertion order across multiple appends', async () => {
    const path = join(testDir, 'costs.jsonl');
    await appendJsonl(path, { seq: 1, usd: 0.01 });
    await appendJsonl(path, { seq: 2, usd: 0.02 });
    await appendJsonl(path, { seq: 3, usd: 0.03 });

    const entries = await readJsonl<{ seq: number; usd: number }>(path);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('readJsonl returns empty array when file does not exist', async () => {
    const result = await readJsonl(join(testDir, 'non-existent.jsonl'));
    expect(result).toEqual([]);
  });

  it('each line is parsed independently as a separate entry', async () => {
    const path = join(testDir, 'costs.jsonl');
    await appendJsonl(path, { model: 'claude-opus-4-7', usd: 0.1 });
    await appendJsonl(path, { model: 'claude-sonnet-4-6', usd: 0.02 });

    const entries = await readJsonl<{ model: string; usd: number }>(path);
    expect(entries[0]?.model).toBe('claude-opus-4-7');
    expect(entries[1]?.model).toBe('claude-sonnet-4-6');
  });
});
