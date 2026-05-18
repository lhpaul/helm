import { join } from 'node:path';
import { z } from 'zod';
import { GitHubProjectsAdapter } from '@helm/adapters';
import type { NormalizedItem } from '@helm/adapters';
import { ensureDataDir, writeJsonAtomic, readJson } from '@helm/storage';
import { INITIAL_STAGE } from '@helm/workflow';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import { EXTERNAL_ID_REGEX } from './types.js';
import type { ItemState, WorkflowEvent } from './types.js';

// Runtime guard for ItemState read from disk — malformed JSON should rebuild rather than crash.
const WorkflowEventSchema = z.object({
  fromStage: z.string().nullable(),
  toStage: z.string(),
  triggeredBy: z.string(),
  at: z.string(),
  note: z.string().optional(),
});
const ItemStateSchema = z.object({
  externalId: z.string(),
  productSlug: z.string(),
  currentStage: z.string(),
  history: z.array(WorkflowEventSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function parseExistingState(raw: unknown): ItemState | null {
  const result = ItemStateSchema.safeParse(raw);
  return result.success ? (result.data as ItemState) : null;
}

export type SyncResult = {
  synced: number;
  skipped: number;
  durationMs: number;
};

// Injectable interfaces for testing without filesystem or network.
type ListItemsFn = () => Promise<NormalizedItem[]>;
type WriteJsonFn = (filePath: string, data: unknown) => Promise<void>;
type ReadJsonFn = <T>(filePath: string) => Promise<T | null>;

export type SyncOptions = {
  /** Injectable adapter list function — defaults to a fresh GitHubProjectsAdapter. */
  _listItems?: ListItemsFn;
  /** Injectable writer — defaults to writeJsonAtomic. */
  _writeJson?: WriteJsonFn;
  /** Injectable reader — defaults to readJson (used to preserve existing createdAt). */
  _readJson?: ReadJsonFn;
};

/**
 * Reads all items from the GitHub Project configured on `product` and writes
 * them to `data/items/{externalId}.json` using the same ItemState shape that
 * the webhook handler produces.
 *
 * Idempotency: if an item file already exists, its `createdAt` is preserved
 * and `updatedAt` is only advanced when the stage actually changes.
 * Items with invalid externalIds are skipped with a warning.
 *
 * Supports both GitHub org and personal (user) accounts.
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

  const listItems: ListItemsFn =
    options?._listItems ??
    (() => {
      const adapter = new GitHubProjectsAdapter(issue_tracker, token, { ttlMs: 0 });
      return adapter.listItems();
    });

  const writeJson: WriteJsonFn = options?._writeJson ?? writeJsonAtomic;
  const readJsonFn: ReadJsonFn = options?._readJson ?? readJson;

  const items = await listItems();
  const paths = await ensureDataDir(dataRoot);

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

    const filePath = join(paths.items, `${item.externalId}.json`);
    const currentStage: WorkflowStage = item.subStage ?? INITIAL_STAGE;

    // Read and validate existing state — treat malformed disk data as absent (rebuild).
    const rawExisting = await readJsonFn<unknown>(filePath);
    const existing = rawExisting !== null ? parseExistingState(rawExisting) : null;
    const now = new Date().toISOString();

    let state: ItemState;
    if (existing !== null) {
      if (existing.currentStage === currentStage) {
        // Stage unchanged — preserve file as-is (true idempotency, no write needed).
        synced++;
        console.log(
          `[sync] product=${slug} item=${item.externalId} title="${item.title}" stage=${currentStage} (unchanged)`,
        );
        continue;
      }
      // Stage changed — append transition event, preserve original createdAt.
      const event: WorkflowEvent = {
        fromStage: existing.currentStage,
        toStage: currentStage,
        triggeredBy: 'sync:github-projects',
        at: now,
      };
      state = {
        ...existing,
        currentStage,
        history: [...existing.history, event],
        updatedAt: now,
      };
    } else {
      // New item — create fresh.
      const creationEvent: WorkflowEvent = {
        fromStage: null,
        toStage: currentStage,
        triggeredBy: 'sync:github-projects',
        at: now,
      };
      state = {
        externalId: item.externalId,
        productSlug: slug,
        currentStage,
        history: [creationEvent],
        createdAt: now,
        updatedAt: now,
      };
    }

    await writeJson(filePath, state);
    console.log(
      `[sync] product=${slug} item=${item.externalId} title="${item.title}" stage=${currentStage}`,
    );
    synced++;
  }

  return { synced, skipped, durationMs: Date.now() - start };
}
