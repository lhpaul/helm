import { join, dirname } from 'node:path';
import { ensureDataDir } from '@helm/storage';
import { parseProductConfigFromFile, loadProductRegistry } from '@helm/shared';
import type { Product } from '@helm/shared';
import { GitHubProjectsAdapter } from '@helm/adapters';
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

// ── GitHubProjectsAdapter singleton ──────────────────────────────────────────

let _githubAdapter: GitHubProjectsAdapter | null = null;
let _githubAdapterPromise: Promise<GitHubProjectsAdapter> | null = null;

/**
 * Returns the shared GitHubProjectsAdapter, initializing it on first call.
 * Single-flight: concurrent callers await the same initialization promise.
 * Reads GITHUB_TOKEN from env; requires issue_tracker.provider === 'github_projects'.
 */
export async function getGitHubAdapter(): Promise<GitHubProjectsAdapter> {
  if (_githubAdapter !== null) return _githubAdapter;
  if (_githubAdapterPromise !== null) return _githubAdapterPromise;

  _githubAdapterPromise = (async () => {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) throw new Error('GITHUB_TOKEN environment variable is not set or blank');

    const config = await getProductConfig();
    if (config.issue_tracker.provider !== 'github_projects') {
      throw new Error(
        `getGitHubAdapter requires provider 'github_projects', got '${config.issue_tracker.provider}'`,
      );
    }
    _githubAdapter = new GitHubProjectsAdapter(config.issue_tracker, token);
    return _githubAdapter;
  })();

  try {
    return await _githubAdapterPromise;
  } finally {
    _githubAdapterPromise = null;
  }
}

// ── Product registry (multi-product) ─────────────────────────────────────────

let _productRegistry: Product[] | null = null;
let _productRegistryPromise: Promise<Product[]> | null = null;

/**
 * Returns all registered Products, initializing from the registry on first call.
 * Single-flight: concurrent callers await the same promise.
 *
 * Discovery order:
 *   1. If $HELM_KNOWLEDGE_REPO_PATH/.helm/products.yaml exists → load all products listed there.
 *   2. Otherwise (ENOENT) → fall back to [getProductConfig()] for single-product backward compat.
 *
 * Paths in products.yaml are resolved relative to dirname(HELM_KNOWLEDGE_REPO_PATH)
 * (the "sibling layout" — see ADR-004).
 */
export async function getProductRegistry(): Promise<Product[]> {
  if (_productRegistry !== null) return _productRegistry.map((p) => structuredClone(p));
  if (_productRegistryPromise !== null) {
    return _productRegistryPromise.then((products) => products.map((p) => structuredClone(p)));
  }

  _productRegistryPromise = (async () => {
    const knowledgePath = process.env.HELM_KNOWLEDGE_REPO_PATH?.trim();
    if (!knowledgePath) throw new Error('HELM_KNOWLEDGE_REPO_PATH environment variable not set');

    const registryFilePath = join(knowledgePath, '.helm', 'products.yaml');
    const baseDir = dirname(knowledgePath);

    let products: Product[];
    try {
      products = await loadProductRegistry(registryFilePath, baseDir);
    } catch (err) {
      // Fall back to single-product mode ONLY when the registry file itself is absent.
      // Any other ENOENT (e.g., a referenced product.yaml is missing) must propagate so
      // the operator can diagnose the broken registry entry instead of silently losing it.
      const isMissingRegistryFile =
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === 'ENOENT' &&
        'path' in err &&
        (err as { path: string }).path === registryFilePath;

      if (isMissingRegistryFile) {
        products = [await getProductConfig()];
      } else {
        throw err;
      }
    }

    _productRegistry = products.map((p) => structuredClone(p));
    return _productRegistry.map((p) => structuredClone(p));
  })();

  try {
    const products = await _productRegistryPromise;
    return products.map((p) => structuredClone(p));
  } finally {
    _productRegistryPromise = null;
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
  _githubAdapter = null;
  _githubAdapterPromise = null;
  _productRegistry = null;
  _productRegistryPromise = null;
}
