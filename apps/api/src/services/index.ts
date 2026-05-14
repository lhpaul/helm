import { join } from 'node:path';
import { ensureDataDir } from '@helm/storage';
import { ItemStore } from './item-store.js';

/**
 * Module-level lazy singleton for the ItemStore.
 * Tests should bypass this and instantiate ItemStore directly with a tmpdir.
 */
let _itemStore: ItemStore | null = null;

/**
 * In-flight init promise so concurrent first-callers all await the same
 * initialization instead of each spawning their own ensureDataDir call.
 * Cleared after initialization completes (success or failure).
 */
let _initPromise: Promise<ItemStore> | null = null;

/**
 * Returns the shared ItemStore instance, initializing it on first call.
 * Single-flight: concurrent calls during startup await the same promise.
 * Reads HELM_DATA_DIR from env (defaults to 'data/' relative to process CWD).
 */
export async function getItemStore(): Promise<ItemStore> {
  // Fast path: already initialized.
  if (_itemStore !== null) return _itemStore;

  // Mid-flight: another caller is already initializing — await the same promise.
  if (_initPromise !== null) return _initPromise;

  // First caller: kick off initialization and store the promise so concurrent
  // callers can join it.
  _initPromise = (async () => {
    // Use ?.trim() + truthiness so an empty-string value (as in .env.example
    // before it is filled in) falls through to the documented default.
    const envDataDir = process.env.HELM_DATA_DIR?.trim();
    const dataRoot = envDataDir ? envDataDir : join(process.cwd(), 'data');
    const paths = await ensureDataDir(dataRoot);
    _itemStore = new ItemStore(paths.items);
    return _itemStore;
  })();

  try {
    return await _initPromise;
  } finally {
    // Clear so a failed init allows the next caller to retry.
    _initPromise = null;
  }
}
