import { join } from 'node:path';
import { ensureDataDir } from '@helm/storage';
import { parseProductConfigFromFile, loadProductRegistry, ProductConfigError } from '@helm/shared';
import type { Product } from '@helm/shared';
import { GitHubProjectsAdapter } from '@helm/adapters';
import { ItemStore } from './item-store.js';
import { JobStore } from './job-store.js';

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

// ── JobStore singleton ────────────────────────────────────────────────────────

let _jobStore: JobStore | null = null;
let _jobInitPromise: Promise<JobStore> | null = null;

/**
 * Returns the shared JobStore instance, initializing it on first call.
 * Single-flight: concurrent calls during startup await the same promise.
 * Reads HELM_DATA_DIR from env (defaults to 'data/' relative to process CWD).
 */
export async function getJobStore(): Promise<JobStore> {
  if (_jobStore !== null) return _jobStore;
  if (_jobInitPromise !== null) return _jobInitPromise;

  _jobInitPromise = (async () => {
    const envDataDir = process.env.HELM_DATA_DIR?.trim();
    const dataRoot = envDataDir ? envDataDir : join(process.cwd(), 'data');
    const paths = await ensureDataDir(dataRoot);
    _jobStore = new JobStore(paths.jobs);
    return _jobStore;
  })();

  try {
    return await _jobInitPromise;
  } finally {
    _jobInitPromise = null;
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
 * Paths in products.yaml are resolved relative to HELM_KNOWLEDGE_REPO_PATH itself
 * (the knowledge repo root). Example: path "." → the repo itself; path
 * "../helm-playground-knowledge" → a sibling repo. See ADR-004.
 */
export async function getProductRegistry(): Promise<Product[]> {
  if (_productRegistry !== null) return _productRegistry.map((p) => structuredClone(p));
  if (_productRegistryPromise !== null) {
    return _productRegistryPromise.then((products) => products.map((p) => structuredClone(p)));
  }

  _productRegistryPromise = (async () => {
    const knowledgePath = process.env.HELM_KNOWLEDGE_REPO_PATH?.trim();
    if (!knowledgePath) throw new Error('HELM_KNOWLEDGE_REPO_PATH environment variable not set');
    const SAFE_FS_PATH_REGEX = /^[A-Za-z0-9._/\-]+$/;
    if (!SAFE_FS_PATH_REGEX.test(knowledgePath)) {
      throw new Error('HELM_KNOWLEDGE_REPO_PATH contains invalid characters');
    }

    const registryFilePath = join(knowledgePath, '.helm', 'products.yaml');
    const baseDir = knowledgePath; // paths in products.yaml are relative to the knowledge repo itself

    let products: Product[];
    try {
      products = await loadProductRegistry(registryFilePath, baseDir);
    } catch (err) {
      // Fall back to single-product mode ONLY when the registry file itself is absent.
      // ProductConfigError wraps the fs error: .code is preserved directly, but .path
      // lives on .cause (the original NodeJS.ErrnoException). Checking .cause.path
      // ensures we don't swallow ENOENT errors from a referenced product.yaml being
      // missing — those must propagate so the operator can diagnose the broken entry.
      const isMissingRegistryFile =
        err instanceof ProductConfigError &&
        err.code === 'ENOENT' &&
        (err.cause as NodeJS.ErrnoException | undefined)?.path === registryFilePath;

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
  _jobStore = null;
  _jobInitPromise = null;
  _productConfig = null;
  _productInitPromise = null;
  _githubAdapter = null;
  _githubAdapterPromise = null;
  _productRegistry = null;
  _productRegistryPromise = null;
}
