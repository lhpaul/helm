import { join } from 'node:path';
import { ensureDataDir } from '@helm/storage';
import { ItemStore } from './item-store.js';

/**
 * Module-level lazy singleton for the ItemStore.
 * Tests should bypass this and instantiate ItemStore directly with a tmpdir.
 */
let _itemStore: ItemStore | null = null;

/**
 * Returns the shared ItemStore instance, initializing it on first call.
 * Reads HELM_DATA_DIR from env (defaults to 'data/' relative to process CWD).
 */
export async function getItemStore(): Promise<ItemStore> {
  if (_itemStore !== null) return _itemStore;
  const dataRoot = process.env.HELM_DATA_DIR ?? join(process.cwd(), 'data');
  const paths = await ensureDataDir(dataRoot);
  _itemStore = new ItemStore(paths.items);
  return _itemStore;
}
