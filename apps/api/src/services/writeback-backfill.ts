import { GitHubProjectsAdapter, LinearAdapter } from '@helm/adapters';
import type { IssueTrackerAdapter } from '@helm/adapters';
import { ensureDataDir } from '@helm/storage';
import { nativeStateTypeForStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import { TRACKER_WRITE_TIMEOUT_MS, withTimeout } from '../lib/with-timeout.js';
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
  /** Items whose stage (sub-stage label) was successfully written to the tracker. */
  reconciled: number;
  /** Total items found in the store. */
  total: number;
  /** Items whose label writeback threw (logged, did not abort the run). */
  failed: number;
  /**
   * Items whose native workflow Status was set (ADR-034, Linear only). Always 0
   * for non-Linear products or adapters without the capability.
   */
  nativeReconciled: number;
  /** Items whose native-state write threw (logged, secondary — does not flip `failed`). */
  nativeFailed: number;
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
  // NOTE: dataRoot is intentionally NOT re-validated here. isSafeFsPath guards
  // UNTRUSTED user env input (HELM_KNOWLEDGE_REPO_PATH / HELM_DATA_DIR, checked
  // at the CLI). dataRoot may instead be a trusted computed default
  // (join(process.cwd(), 'data')), which can legitimately contain characters the
  // allowlist rejects (e.g. a space in '/Users/My Name/…'). Validating it here
  // would reject valid working directories.
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
  // propagates to the caller rather than being swallowed per-item. Bounded so a
  // stalled tracker connection can't hang the whole run indefinitely.
  await withTimeout(
    adapter.ensureSubStages(product.issue_tracker),
    TRACKER_WRITE_TIMEOUT_MS,
    'ensureSubStages',
  );

  // Native-state mirroring (ADR-034) is Linear-only and feature-detected, so a
  // GitHub product or an injected adapter without the capability skips it.
  const mirrorsNativeState =
    product.issue_tracker.provider === 'linear' &&
    typeof adapter.setWorkflowStateByType === 'function';

  let reconciled = 0;
  let failed = 0;
  let nativeReconciled = 0;
  let nativeFailed = 0;
  for (const item of items) {
    try {
      // Bounded per item so one stalled item fails (and is counted) instead of
      // blocking the rest of the batch indefinitely.
      await withTimeout(
        adapter.setSubStage(item.externalId, item.currentStage),
        TRACKER_WRITE_TIMEOUT_MS,
        `setSubStage ${item.externalId}`,
      );
      reconciled++;
      console.log(
        `[writeback-backfill] product=${slug} item=${item.externalId} stage=${item.currentStage}`,
      );
    } catch (err) {
      failed++;
      console.error(
        `[writeback-backfill] product=${slug} item=${item.externalId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Independent best-effort native-state set — a failure here is secondary and
    // does NOT flip the item to `failed` (the label is the primary signal).
    if (mirrorsNativeState) {
      const type = nativeStateTypeForStage(item.currentStage);
      try {
        await withTimeout(
          adapter.setWorkflowStateByType!(item.externalId, type),
          TRACKER_WRITE_TIMEOUT_MS,
          `setWorkflowStateByType ${item.externalId}`,
        );
        nativeReconciled++;
        console.log(
          `[writeback-backfill] product=${slug} item=${item.externalId} native-state=${type}`,
        );
      } catch (err) {
        nativeFailed++;
        console.error(
          `[writeback-backfill] product=${slug} item=${item.externalId} native-state failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return {
    reconciled,
    total: items.length,
    failed,
    nativeReconciled,
    nativeFailed,
    durationMs: Date.now() - start,
  };
}
