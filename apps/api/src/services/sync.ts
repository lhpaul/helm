import { join } from 'node:path';
import { GitHubProjectsAdapter } from '@helm/adapters';
import type { NormalizedItem } from '@helm/adapters';
import { ensureDataDir, writeJsonAtomic } from '@helm/storage';
import { INITIAL_STAGE } from '@helm/workflow';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import { EXTERNAL_ID_REGEX } from './types.js';
import type { ItemState, WorkflowEvent } from './types.js';

export type SyncResult = {
  synced: number;
  skipped: number;
  durationMs: number;
};

// Injectable interfaces for testing without filesystem or network.
type ListItemsFn = () => Promise<NormalizedItem[]>;
type WriteJsonFn = (filePath: string, data: unknown) => Promise<void>;

export type SyncOptions = {
  /** Injectable adapter — defaults to a fresh GitHubProjectsAdapter. */
  _listItems?: ListItemsFn;
  /** Injectable writer — defaults to writeJsonAtomic. */
  _writeJson?: WriteJsonFn;
};

/**
 * Reads all items from the GitHub Project configured on `product` and writes
 * them to `data/items/{externalId}.json` using the same ItemState shape that
 * the webhook handler produces.
 *
 * Idempotent: running twice overwrites files with identical content.
 * Items with invalid externalIds are skipped with a warning.
 *
 * Uses the adapter's listItems() which paginates automatically up to GitHub's
 * 100-item-per-page cap. Supports both org and personal (user) GitHub accounts.
 *
 * @param product   - Product whose issue_tracker will be queried.
 * @param token     - GitHub PAT with read access to the project.
 * @param dataRoot  - Absolute path to Helm's data/ directory.
 * @param options   - Optional injectable overrides for testing.
 */
export async function syncProductItems(
  product: Product,
  token: string,
  dataRoot: string,
  options?: SyncOptions,
): Promise<SyncResult> {
  const { issue_tracker } = product;

  if (issue_tracker.provider !== 'github_projects') {
    throw new Error(
      `sync only supports provider 'github_projects', got '${issue_tracker.provider}'`,
    );
  }

  const slug = product.product.slug;
  const start = Date.now();

  // Build the list function — real adapter with no caching (ttlMs:0) in production,
  // or a test double injected via options.
  const listItems: ListItemsFn =
    options?._listItems ??
    (() => {
      const adapter = new GitHubProjectsAdapter(issue_tracker, token, { ttlMs: 0 });
      return adapter.listItems();
    });

  const writeJson: WriteJsonFn = options?._writeJson ?? writeJsonAtomic;

  const items = await listItems();

  const paths = await ensureDataDir(dataRoot);

  const now = new Date().toISOString();
  let synced = 0;
  let skipped = 0;

  for (const item of items) {
    if (!EXTERNAL_ID_REGEX.test(item.externalId)) {
      console.warn(
        `[sync] product=${slug} skipping item with invalid externalId: ${item.externalId}`,
      );
      skipped++;
      continue;
    }

    const currentStage: WorkflowStage = item.subStage ?? INITIAL_STAGE;
    const creationEvent: WorkflowEvent = {
      fromStage: null,
      toStage: currentStage,
      triggeredBy: 'sync:github-projects',
      at: now,
    };

    const state: ItemState = {
      externalId: item.externalId,
      productSlug: slug,
      currentStage,
      history: [creationEvent],
      createdAt: now,
      updatedAt: now,
    };

    const filePath = join(paths.items, `${item.externalId}.json`);
    await writeJson(filePath, state);

    console.log(
      `[sync] product=${slug} item=${item.externalId} title="${item.title}" stage=${currentStage}`,
    );
    synced++;
  }

  return { synced, skipped, durationMs: Date.now() - start };
}
