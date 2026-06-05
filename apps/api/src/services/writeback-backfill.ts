import { GitHubProjectsAdapter, LinearAdapter } from '@helm/adapters';
import type { IssueTrackerAdapter } from '@helm/adapters';
import { ensureDataDir } from '@helm/storage';
import type { Product } from '@helm/shared';
import { ItemStore } from './item-store.js';
import type { ItemState } from './types.js';

/**
 * One-shot tracker reconciliation (ADR-033).
 *
 * Writeback is best-effort, so the store and the tracker can drift — and items
 * that advanced BEFORE writeback existed were never reflected at all. This
 * command is the recovery tool: it runs `ensureSubStages` once (the `helm:*`
 * labels / single-select options may not exist yet), then pushes every store
 * item's current stage to the tracker.
 *
 * Unlike `sync` (tracker→store hydration, GitHub-only), this is store→tracker
 * and supports BOTH providers — the AF pilot is Linear.
 */

export type BackfillResult = {
  /** Items whose stage was successfully written to the tracker. */
  reconciled: number;
  /** Total items found in the store. */
  total: number;
  /** Items whose writeback threw (logged, did not abort the run). */
  failed: number;
  durationMs: number;
};

export type BackfillOptions = {
  /** Injectable adapter — defaults to one built from `product` + `credential`. */
  _adapter?: IssueTrackerAdapter;
  /** Injectable store item list — defaults to ItemStore(dataRoot/items).list(). */
  _listItems?: () => Promise<ItemState[]>;
};

/**
 * Builds the provider-appropriate adapter for `product`. Mirrors the resolution
 * in `getIssueTrackerAdapter`, but scoped to the passed product (the command
 * takes a slug) rather than the single-product config singleton.
 */
function buildAdapter(product: Product, credential: string): IssueTrackerAdapter {
  const { issue_tracker } = product;
  // Widen to string up front so it stays referenceable in the exhaustive
  // default branch (where the discriminated union narrows to `never`).
  const provider: string = issue_tracker.provider;
  if (issue_tracker.provider === 'github_projects') {
    return new GitHubProjectsAdapter(issue_tracker, credential, { ttlMs: 0 });
  }
  if (issue_tracker.provider === 'linear') {
    return new LinearAdapter(issue_tracker, credential, { ttlMs: 0 });
  }
  throw new Error(`writeback-backfill: unsupported issue_tracker.provider '${provider}'`);
}

/**
 * Reconciles every store item's current stage to the tracker for `product`.
 *
 * Runs `ensureSubStages` once (propagates on failure — if the stage map cannot
 * be created, no item could be reconciled). Then iterates every item with a
 * per-item try/catch so a single failure (item missing from the tracker, API
 * hiccup) is logged and the rest still reconcile.
 *
 * @param product    - Product whose tracker will be reconciled.
 * @param credential - GitHub PAT or Linear API key, per provider.
 * @param dataRoot   - Absolute path to Helm's data/ directory.
 * @param options    - Optional injectable overrides for testing.
 */
export async function backfillProductStages(
  product: Product,
  credential: string,
  dataRoot: string,
  options?: BackfillOptions,
): Promise<BackfillResult> {
  const slug = product.product.slug;
  const start = Date.now();

  const adapter = options?._adapter ?? buildAdapter(product, credential);

  const listItems =
    options?._listItems ??
    (async () => {
      const paths = await ensureDataDir(dataRoot);
      return new ItemStore(paths.items).list();
    });

  // The item store is shared across products (a single data/items/ directory),
  // and unlike `sync` (which lists from the per-product tracker) this lists from
  // the store. Scope to THIS product's items so a multi-product instance never
  // pushes another product's items onto this product's tracker.
  const allItems = await listItems();
  const items = allItems.filter((it) => it.productSlug === slug);

  // Ensure the stage map exists once before any setSubStage. A failure here is
  // fatal to the run (GitHub setSubStage would throw for every item), so it
  // propagates to the caller rather than being swallowed per-item.
  await adapter.ensureSubStages(product.issue_tracker);

  let reconciled = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await adapter.setSubStage(item.externalId, item.currentStage);
      reconciled++;
      console.log(
        `[writeback-backfill] product=${slug} item=${item.externalId} stage=${item.currentStage}`,
      );
    } catch (err) {
      failed++;
      console.warn(
        `[writeback-backfill] product=${slug} item=${item.externalId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { reconciled, total: items.length, failed, durationMs: Date.now() - start };
}
