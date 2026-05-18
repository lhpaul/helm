/**
 * helm sync — manual item hydration from GitHub Projects v2.
 *
 * Usage:
 *   pnpm --filter @helm/api sync <productSlug>
 *
 * Required env vars:
 *   GITHUB_TOKEN                — GitHub PAT with project read access
 *   HELM_KNOWLEDGE_REPO_PATH    — path to the primary knowledge repo
 *
 * Optional env vars:
 *   HELM_DATA_DIR               — defaults to ./data relative to CWD
 */
import { join } from 'node:path';
import { getProductRegistry } from '../services/index.js';
import { syncProductItems } from '../services/sync.js';

async function main(): Promise<void> {
  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error('Usage: pnpm --filter @helm/api sync <productSlug>');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is not set or blank');
    process.exit(1);
  }

  const knowledgeRepoPath = process.env.HELM_KNOWLEDGE_REPO_PATH?.trim();
  if (!knowledgeRepoPath) {
    console.error('Error: HELM_KNOWLEDGE_REPO_PATH environment variable is not set or blank');
    process.exit(1);
  }

  const SAFE_FS_PATH_REGEX = /^[A-Za-z0-9._/\-]+$/;
  if (!SAFE_FS_PATH_REGEX.test(knowledgeRepoPath)) {
    console.error('Error: HELM_KNOWLEDGE_REPO_PATH contains invalid characters');
    process.exit(1);
  }

  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  if (envDataDir && !SAFE_FS_PATH_REGEX.test(envDataDir)) {
    console.error('Error: HELM_DATA_DIR contains invalid characters');
    process.exit(1);
  }
  const dataRoot = envDataDir || join(process.cwd(), 'data');

  let products;
  try {
    products = await getProductRegistry();
  } catch (err) {
    console.error(
      `[sync] Failed to load product registry: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const product = products.find((p) => p.product.slug === slug);
  if (!product) {
    const known = products.map((p) => p.product.slug).join(', ');
    console.error(`[sync] Product not found: "${slug}". Known products: ${known}`);
    process.exit(1);
  }

  if (product.issue_tracker.provider !== 'github_projects') {
    console.log(
      `[sync] Product "${slug}" uses provider "${product.issue_tracker.provider}" — sync only supports github_projects. Nothing to do.`,
    );
    process.exit(0);
  }

  console.log(`[sync] Starting sync for product "${slug}"…`);

  try {
    const result = await syncProductItems(product, token, dataRoot);
    const noun = result.synced === 1 ? 'item' : 'items';
    console.log(`Synced ${result.synced} ${noun} in ${result.durationMs}ms`);
    if (result.skipped > 0) {
      console.warn(`[sync] Skipped ${result.skipped} item(s) with invalid externalId`);
    }
  } catch (err) {
    console.error(`[sync] Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[sync] Unexpected error:', err);
  process.exit(1);
});
