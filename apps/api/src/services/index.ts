import { join } from 'node:path';
import { ensureDataDir } from '@helm/storage';
import { parseProductConfigFromFile } from '@helm/shared';
import type { Product } from '@helm/shared';
import { ItemStore } from './item-store.js';

// ── ItemStore singleton ───────────────────────────────────────────────────────

let _itemStore: ItemStore | null = null;
let _itemInitPromise: Promise<ItemStore> | null = null;

/**
 * Returns the shared ItemStore instance, initializing it on first call.
 * Single-flight: concurrent calls during startup await the same promise.
 * Reads HELM_DATA_DIR from env (defaults to 'data/' relative to process CWD).
 */
export async function getItemStore(): Promise<ItemStore> {
  if (_itemStore !== null) return _itemStore;
  if (_itemInitPromise !== null) return _itemInitPromise;

  _itemInitPromise = (async () => {
    const envDataDir = process.env.HELM_DATA_DIR?.trim();
    const dataRoot = envDataDir ? envDataDir : join(process.cwd(), 'data');
    const paths = await ensureDataDir(dataRoot);
    _itemStore = new ItemStore(paths.items);
    return _itemStore;
  })();

  try {
    return await _itemInitPromise;
  } finally {
    _itemInitPromise = null;
  }
}

// ── Product config singleton ──────────────────────────────────────────────────

let _productConfig: Product | null = null;
let _productInitPromise: Promise<Product> | null = null;

/**
 * Returns the cached Product config, loading it on first call.
 * Single-flight: concurrent callers await the same initialization promise.
 * Reads HELM_KNOWLEDGE_REPO_PATH from env to locate .helm/product.yaml.
 */
export async function getProductConfig(): Promise<Product> {
  if (_productConfig !== null) return _productConfig;
  if (_productInitPromise !== null) return _productInitPromise;

  _productInitPromise = (async () => {
    const knowledgePath = process.env.HELM_KNOWLEDGE_REPO_PATH?.trim();
    if (!knowledgePath) {
      throw new Error('HELM_KNOWLEDGE_REPO_PATH environment variable not set');
    }
    const configPath = join(knowledgePath, '.helm', 'product.yaml');
    const config = await parseProductConfigFromFile(configPath);
    _productConfig = config;
    return config;
  })();

  try {
    return await _productInitPromise;
  } finally {
    _productInitPromise = null;
  }
}

// ── Test utilities ────────────────────────────────────────────────────────────

/**
 * Resets all service singletons so the next call re-initializes from env.
 * For use in tests only — do not call in production code.
 */
export function _resetForTests(): void {
  _itemStore = null;
  _itemInitPromise = null;
  _productConfig = null;
  _productInitPromise = null;
}
