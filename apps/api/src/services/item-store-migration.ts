import { link, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readJson } from '@helm/storage';
import { EXTERNAL_ID_REGEX } from './types.js';

const SLUG_REGEX = /^[a-z0-9-]+$/;

export type LegacyMigrationReport = {
  migrated: number;
  skipped: { file: string; reason: string }[];
};

/**
 * Moves legacy flat items (data/items/{externalId}.json) into the per-product
 * layout (data/items/{productSlug}/{externalId}.json), using the `productSlug`
 * recorded inside each file (ADR-004 v1 fix path).
 *
 * - Idempotent: once flat files are gone it is a no-op.
 * - Never overwrites: if the destination exists the legacy file stays put and is
 *   reported as skipped.
 * - Throws on unexpected I/O failures so the caller can retry (nothing is lost:
 *   the legacy file stays until the move completes).
 * - Never deletes: unparseable files or files with a missing/unsafe slug or a
 *   name that disagrees with their externalId are left in place and reported.
 *
 * Rollback: move files from each {productSlug}/ directory back up to the root.
 */
export async function migrateLegacyItems(itemsRoot: string): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = { migrated: 0, skipped: [] };
  let entries: string[];
  try {
    entries = await readdir(itemsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return report;
    throw err;
  }

  for (const file of entries.filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    const from = join(itemsRoot, file);
    try {
      if (!(await stat(from)).isFile()) continue;
      let state: { externalId?: unknown; productSlug?: unknown } | null;
      try {
        state = await readJson<{ externalId?: unknown; productSlug?: unknown }>(from);
      } catch {
        report.skipped.push({ file, reason: 'unparseable' });
        continue;
      }
      const externalId = file.slice(0, -'.json'.length);
      const slug = state?.productSlug;
      if (typeof slug !== 'string' || !SLUG_REGEX.test(slug)) {
        report.skipped.push({ file, reason: 'missing or unsafe productSlug' });
        continue;
      }
      if (!EXTERNAL_ID_REGEX.test(externalId) || state?.externalId !== externalId) {
        report.skipped.push({ file, reason: 'externalId does not match file name' });
        continue;
      }
      const destDir = join(itemsRoot, slug);
      const to = join(destDir, file);
      await mkdir(destDir, { recursive: true });
      // link() fails with EEXIST instead of replacing, so a destination created
      // concurrently (e.g. the API running beside a CLI script) is never lost;
      // unlinking the source afterwards completes an atomic no-replace move.
      try {
        await link(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          report.skipped.push({ file, reason: 'destination already exists' });
          continue;
        }
        throw err;
      }
      await unlink(from);
      report.migrated += 1;
    } catch (err) {
      // Another process already moved/removed it: nothing left to migrate.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Operational failures must not look like a completed migration: callers
      // would otherwise cache success and shadow the unmigrated item.
      throw err;
    }
  }
  return report;
}
