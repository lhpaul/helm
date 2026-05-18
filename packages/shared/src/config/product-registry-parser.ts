import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ProductRegistrySchema } from './product-registry-schema.js';
import { parseProductConfigFromFile, ProductConfigError } from './product-parser.js';
import type { Product } from './product-schema.js';

/**
 * Parses a YAML string into a validated ProductRegistry structure.
 * Does NOT load individual product configs — use loadProductRegistry for that.
 * Throws ProductConfigError on invalid YAML or schema violations.
 */
export function parseProductRegistryYaml(yamlContent: string): Array<{ path: string }> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    throw new ProductConfigError('Failed to parse products.yaml', err as Error);
  }

  const result = ProductRegistrySchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? '(root)';
    const message = firstIssue?.message ?? 'Unknown validation error';
    throw new ProductConfigError(`Invalid products.yaml — "${path}": ${message}`, result.error);
  }

  return result.data.products;
}

/**
 * Loads and resolves all products listed in a products.yaml registry file.
 *
 * @param registryFilePath - absolute path to the products.yaml file
 * @param baseDir - directory used to resolve relative paths listed in the registry.
 *   Typically the parent directory of the primary knowledge repo
 *   (i.e., path.dirname(HELM_KNOWLEDGE_REPO_PATH)).
 *
 * Each entry's `path` is resolved via path.resolve(baseDir, entry.path).
 * Absolute paths in entries are used as-is (path.resolve handles this).
 *
 * Throws ProductConfigError if the registry file is unreadable or invalid.
 * Throws ProductConfigError for any individual product.yaml that fails to load.
 */
export async function loadProductRegistry(
  registryFilePath: string,
  baseDir: string,
): Promise<Product[]> {
  let content: string;
  try {
    content = await readFile(registryFilePath, 'utf-8');
  } catch (err) {
    const fsErr = err as NodeJS.ErrnoException;
    throw new ProductConfigError(
      `Cannot read products.yaml: ${registryFilePath}`,
      fsErr,
      fsErr.code,
    );
  }

  const entries = parseProductRegistryYaml(content);
  const products: Product[] = [];

  for (const entry of entries) {
    const repoPath = resolve(baseDir, entry.path);
    const productYamlPath = join(repoPath, '.helm', 'product.yaml');
    // Let individual product parse errors propagate — caller decides whether
    // to skip malformed products or treat it as a fatal error.
    const product = await parseProductConfigFromFile(productYamlPath);
    products.push(product);
  }

  return products;
}
