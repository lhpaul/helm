import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemAlreadyExistsError } from './errors.js';
import { ItemStore } from './item-store.js';
import { migrateLegacyItems } from './item-store-migration.js';

let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `helm-ns-${randomUUID()}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function writeLegacy(externalId: string, productSlug: unknown, extra = {}) {
  const state = {
    externalId,
    productSlug,
    currentStage: 'plan-ready',
    history: [],
    createdAt: 't',
    updatedAt: 't',
    ...extra,
  };
  await writeFile(join(root, `${externalId}.json`), JSON.stringify(state));
  return state;
}

describe('ItemStore namespacing (#126)', () => {
  it('stores items under {root}/{productSlug}/{externalId}.json', async () => {
    const store = new ItemStore(root, 'alpha');
    await store.create({ externalId: 'issue_1', productSlug: 'alpha', triggeredBy: 't' });
    expect(await exists(join(root, 'alpha', 'issue_1.json'))).toBe(true);
    expect(await exists(join(root, 'issue_1.json'))).toBe(false);
  });

  it('does not let two products with the same externalId overwrite each other', async () => {
    const alpha = new ItemStore(root, 'alpha');
    const beta = new ItemStore(root, 'beta');
    await alpha.create({ externalId: 'issue_1', productSlug: 'alpha', triggeredBy: 't' });
    await beta.create({ externalId: 'issue_1', productSlug: 'beta', triggeredBy: 't' });

    await alpha.transition({ externalId: 'issue_1', toStage: 'spec-draft', triggeredBy: 't' });

    expect((await alpha.get('issue_1'))?.currentStage).toBe('spec-draft');
    expect((await beta.get('issue_1'))?.currentStage).toBe('discovery');
    expect((await beta.get('issue_1'))?.productSlug).toBe('beta');
  });

  it('create is exclusive only within the same product', async () => {
    const alpha = new ItemStore(root, 'alpha');
    await alpha.create({ externalId: 'issue_1', productSlug: 'alpha', triggeredBy: 't' });
    await expect(
      alpha.create({ externalId: 'issue_1', productSlug: 'alpha', triggeredBy: 't' }),
    ).rejects.toBeInstanceOf(ItemAlreadyExistsError);
  });

  it('list returns only the scoped product items', async () => {
    const alpha = new ItemStore(root, 'alpha');
    const beta = new ItemStore(root, 'beta');
    await alpha.create({ externalId: 'issue_1', productSlug: 'alpha', triggeredBy: 't' });
    await beta.create({ externalId: 'issue_1', productSlug: 'beta', triggeredBy: 't' });
    await beta.create({ externalId: 'issue_2', productSlug: 'beta', triggeredBy: 't' });

    expect((await alpha.list()).map((i) => i.externalId)).toEqual(['issue_1']);
    expect((await beta.list()).map((i) => i.externalId).sort()).toEqual(['issue_1', 'issue_2']);
  });

  it('list is empty for a product with no directory yet', async () => {
    expect(await new ItemStore(root, 'ghost').list()).toEqual([]);
  });

  it('rejects creating an item for a different product', async () => {
    const alpha = new ItemStore(root, 'alpha');
    await expect(
      alpha.create({ externalId: 'issue_1', productSlug: 'beta', triggeredBy: 't' }),
    ).rejects.toThrow(/cannot create/);
  });

  it.each(['', '..', '../x', 'a/b', 'A', 'a b', '.hidden'])('rejects unsafe slug %j', (slug) => {
    expect(() => new ItemStore(root, slug)).toThrow(/Invalid productSlug/);
  });
});

describe('migrateLegacyItems (#126)', () => {
  it('propagates unexpected I/O failures and recovers on retry', async () => {
    await writeLegacy('issue_1', 'alpha');
    // A regular file where the product directory must go makes the move fail.
    await writeFile(join(root, 'alpha'), 'blocker');

    await expect(migrateLegacyItems(root)).rejects.toThrow();
    expect(await exists(join(root, 'issue_1.json'))).toBe(true);

    await rm(join(root, 'alpha'));
    expect(await migrateLegacyItems(root)).toEqual({ migrated: 1, skipped: [] });
    expect(await exists(join(root, 'alpha', 'issue_1.json'))).toBe(true);
  });

  it('does not replace a destination that appears after the legacy file was read', async () => {
    await writeLegacy('issue_1', 'alpha', { currentStage: 'merged' });
    const winner = JSON.stringify({ externalId: 'issue_1', productSlug: 'alpha', winner: true });
    // Pre-create the namespaced file, simulating a concurrent writer winning the race.
    await mkdir(join(root, 'alpha'), { recursive: true });
    await writeFile(join(root, 'alpha', 'issue_1.json'), winner);

    const report = await migrateLegacyItems(root);

    expect(report.migrated).toBe(0);
    expect(await readFile(join(root, 'alpha', 'issue_1.json'), 'utf-8')).toBe(winner);
    expect(await exists(join(root, 'issue_1.json'))).toBe(true);
  });

  it('moves flat files into their product namespace, preserving content', async () => {
    const a = await writeLegacy('issue_1', 'alpha');
    const b = await writeLegacy('HLM-2', 'beta');

    const report = await migrateLegacyItems(root);

    expect(report).toEqual({ migrated: 2, skipped: [] });
    expect(await exists(join(root, 'issue_1.json'))).toBe(false);
    expect(JSON.parse(await readFile(join(root, 'alpha', 'issue_1.json'), 'utf-8'))).toEqual(a);
    expect(JSON.parse(await readFile(join(root, 'beta', 'HLM-2.json'), 'utf-8'))).toEqual(b);
  });

  it('keeps a single-product deployment working after upgrade', async () => {
    await writeLegacy('issue_1', 'helm', { currentStage: 'code-review' });
    await migrateLegacyItems(root);

    const store = new ItemStore(root, 'helm');
    expect((await store.get('issue_1'))?.currentStage).toBe('code-review');
    const moved = await store.transition({
      externalId: 'issue_1',
      toStage: 'remediation',
      triggeredBy: 't',
    });
    expect(moved.currentStage).toBe('remediation');
    expect((await store.list()).length).toBe(1);
  });

  it('is idempotent', async () => {
    await writeLegacy('issue_1', 'alpha');
    await migrateLegacyItems(root);
    expect(await migrateLegacyItems(root)).toEqual({ migrated: 0, skipped: [] });
    expect(await exists(join(root, 'alpha', 'issue_1.json'))).toBe(true);
  });

  it('is a no-op when the items directory does not exist', async () => {
    expect(await migrateLegacyItems(join(root, 'missing'))).toEqual({ migrated: 0, skipped: [] });
  });

  it('never overwrites an existing namespaced file', async () => {
    await new ItemStore(root, 'alpha').create({
      externalId: 'issue_1',
      productSlug: 'alpha',
      triggeredBy: 't',
    });
    await writeLegacy('issue_1', 'alpha', { currentStage: 'merged' });

    const report = await migrateLegacyItems(root);

    expect(report.migrated).toBe(0);
    expect(report.skipped).toEqual([
      { file: 'issue_1.json', reason: 'destination already exists' },
    ]);
    expect(await exists(join(root, 'issue_1.json'))).toBe(true);
    expect((await new ItemStore(root, 'alpha').get('issue_1'))?.currentStage).toBe('discovery');
  });

  it('leaves unparseable, slugless, unsafe-slug and mismatched files untouched', async () => {
    await writeFile(join(root, 'bad.json'), '{not json');
    await writeLegacy('noslug', undefined);
    await writeLegacy('evil', '../escape');
    await writeFile(
      join(root, 'renamed.json'),
      JSON.stringify({ externalId: 'other', productSlug: 'alpha' }),
    );
    await writeLegacy('good', 'alpha');

    const report = await migrateLegacyItems(root);

    expect(report.migrated).toBe(1);
    expect(report.skipped.map((s) => s.file).sort()).toEqual([
      'bad.json',
      'evil.json',
      'noslug.json',
      'renamed.json',
    ]);
    const left = (await readdir(root)).sort();
    expect(left).toEqual(['alpha', 'bad.json', 'evil.json', 'noslug.json', 'renamed.json']);
    expect(await exists(join(root, '..', 'escape'))).toBe(false);
  });

  it('ignores dotfiles and non-json entries', async () => {
    await writeFile(join(root, '.DS_Store'), 'x');
    await writeFile(join(root, 'notes.txt'), 'x');
    expect(await migrateLegacyItems(root)).toEqual({ migrated: 0, skipped: [] });
  });
});
