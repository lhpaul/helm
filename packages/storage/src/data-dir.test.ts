import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDataDir,
  getAgentRunDir,
  getCostsPath,
  getInstructionsPath,
  getLinearItemCachePath,
  getLogPath,
  getMetaPath,
} from './data-dir.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `helm-datadir-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('ensureDataDir', () => {
  it('creates root and all expected subdirectories', async () => {
    const paths = await ensureDataDir(testDir);

    const isDir = async (p: string) => (await stat(p)).isDirectory();

    expect(await isDir(paths.agentRuns)).toBe(true);
    expect(await isDir(paths.worktreesCode)).toBe(true);
    expect(await isDir(paths.worktreesKnowledge)).toBe(true);
    expect(await isDir(paths.linearCache)).toBe(true);
    expect(await isDir(paths.reviewers)).toBe(true);
    // linear-cache/items/ is pre-created even though it's not a top-level DataPaths field
    expect(await isDir(join(testDir, 'linear-cache', 'items'))).toBe(true);
  });

  it('is idempotent — calling twice does not throw', async () => {
    await ensureDataDir(testDir);
    await expect(ensureDataDir(testDir)).resolves.toBeDefined();
  });
});

describe('path helpers', () => {
  it('agent-run helpers return expected paths without creating anything', () => {
    const runDir = getAgentRunDir(testDir, 'run-abc123');

    expect(runDir).toBe(join(testDir, 'agent-runs', 'run-abc123'));
    expect(getMetaPath(runDir)).toBe(join(runDir, 'meta.json'));
    expect(getLogPath(runDir)).toBe(join(runDir, 'log.txt'));
    expect(getCostsPath(runDir)).toBe(join(runDir, 'costs.jsonl'));
    expect(getInstructionsPath(runDir)).toBe(join(runDir, 'instructions.txt'));
  });

  it('getLinearItemCachePath returns expected path for a linearId', () => {
    const result = getLinearItemCachePath(testDir, 'HLM-42');

    expect(result).toBe(join(testDir, 'linear-cache', 'items', 'HLM-42.json'));
  });
});
