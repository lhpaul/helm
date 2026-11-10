import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetForTests, getItemStore } from './index.js';

let dataDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  dataDir = join(tmpdir(), `helm-data-${randomUUID()}`);
  await mkdir(join(dataDir, 'items'), { recursive: true });
  prevEnv = process.env.HELM_DATA_DIR;
  process.env.HELM_DATA_DIR = dataDir;
  _resetForTests();
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.HELM_DATA_DIR;
  else process.env.HELM_DATA_DIR = prevEnv;
  _resetForTests();
  await rm(dataDir, { recursive: true, force: true });
});

describe('getItemStore(productSlug) (#126)', () => {
  it('returns one cached store per slug, isolated from each other', async () => {
    const a1 = await getItemStore('alpha');
    expect(await getItemStore('alpha')).toBe(a1);
    const b = await getItemStore('beta');
    expect(b).not.toBe(a1);

    await a1.create({ externalId: 'issue_1', productSlug: 'alpha', triggeredBy: 't' });
    await b.create({ externalId: 'issue_1', productSlug: 'beta', triggeredBy: 't' });
    expect((await a1.list()).length).toBe(1);
  });

  it('migrates legacy flat items on first access', async () => {
    await writeFile(
      join(dataDir, 'items', 'issue_9.json'),
      JSON.stringify({ externalId: 'issue_9', productSlug: 'helm', currentStage: 'merged' }),
    );

    const store = await getItemStore('helm');

    expect((await store.get('issue_9'))?.currentStage).toBe('merged');
    const flat = await stat(join(dataDir, 'items', 'issue_9.json')).then(
      () => true,
      () => false,
    );
    expect(flat).toBe(false);
  });

  it('rejects an unsafe slug', async () => {
    await expect(getItemStore('../x')).rejects.toThrow(/Invalid productSlug/);
  });
});
