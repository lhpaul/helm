/**
 * helm writeback-backfill — one-shot tracker reconciliation (ADR-033).
 *
 * Pushes every store item's current stage to the external issue tracker (Linear
 * label / GitHub Projects single-select). Use it after enabling writeback to
 * reconcile items that advanced before writeback existed, or to recover from
 * best-effort drift.
 *
 * Usage:
 *   pnpm --filter @helm/api writeback-backfill <productSlug>
 *
 * Required env vars:
 *   HELM_KNOWLEDGE_REPO_PATH    — path to the primary knowledge repo
 *   GITHUB_TOKEN                — for github_projects products (project write access)
 *   <api_key_env>               — for linear products, the env var named by
 *                                 issue_tracker.api_key_env (Linear PAT)
 *
 * Optional env vars:
 *   HELM_DATA_DIR               — defaults to ./data relative to CWD
 */
import { join } from 'node:path';
import { getProductRegistry } from '../services/index.js';
import { backfillProductStages } from '../services/writeback-backfill.js';
import { isSafeFsPath } from '../services/types.js';

async function main(): Promise<void> {
  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error('Usage: pnpm --filter @helm/api writeback-backfill <productSlug>');
    process.exit(1);
  }

  const knowledgeRepoPath = process.env.HELM_KNOWLEDGE_REPO_PATH?.trim();
  if (!knowledgeRepoPath) {
    console.error('Error: HELM_KNOWLEDGE_REPO_PATH environment variable is not set or blank');
    process.exit(1);
  }

  if (!isSafeFsPath(knowledgeRepoPath)) {
    console.error(
      "Error: HELM_KNOWLEDGE_REPO_PATH contains invalid characters or '.'/'..' segments",
    );
    process.exit(1);
  }

  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  if (envDataDir && !isSafeFsPath(envDataDir)) {
    console.error("Error: HELM_DATA_DIR contains invalid characters or '.'/'..' segments");
    process.exit(1);
  }
  const dataRoot = envDataDir || join(process.cwd(), 'data');

  let products;
  try {
    products = await getProductRegistry();
  } catch (err) {
    console.error(
      `[writeback-backfill] Failed to load product registry: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const product = products.find((p) => p.product.slug === slug);
  if (!product) {
    const known = products.map((p) => p.product.slug).join(', ');
    console.error(`[writeback-backfill] Product not found: "${slug}". Known products: ${known}`);
    process.exit(1);
  }

  // Resolve the provider-specific credential from env (same resolution as
  // getIssueTrackerAdapter): GITHUB_TOKEN for github_projects, the api_key_env
  // for linear.
  const { issue_tracker } = product;
  // Widen to string up front so it stays referenceable in the exhaustive else
  // branch (where the discriminated union narrows to `never`).
  const provider: string = issue_tracker.provider;
  let credential: string | undefined;
  if (issue_tracker.provider === 'github_projects') {
    credential = process.env.GITHUB_TOKEN?.trim();
    if (!credential) {
      console.error('Error: GITHUB_TOKEN environment variable is not set or blank');
      process.exit(1);
    }
  } else if (issue_tracker.provider === 'linear') {
    credential = process.env[issue_tracker.api_key_env]?.trim();
    if (!credential) {
      console.error(
        `Error: ${issue_tracker.api_key_env} environment variable is not set or blank (required for Linear)`,
      );
      process.exit(1);
    }
  } else {
    console.error(`[writeback-backfill] Unsupported provider: "${provider}"`);
    process.exit(1);
  }

  console.log(`[writeback-backfill] Reconciling tracker stages for product "${slug}"…`);

  try {
    const result = await backfillProductStages(product, credential, dataRoot);
    console.log(`Reconciled ${result.reconciled}/${result.total} items in ${result.durationMs}ms`);
    if (result.failed > 0) {
      console.warn(`[writeback-backfill] ${result.failed} item(s) failed — see logs above`);
    }
    // Native Status mirroring (ADR-034) is Linear-only; for GitHub products
    // nativeReconciled stays 0 and this line is omitted.
    if (result.nativeReconciled > 0 || result.nativeFailed > 0) {
      console.log(`Native Status set on ${result.nativeReconciled}/${result.total} items`);
      if (result.nativeFailed > 0) {
        console.warn(
          `[writeback-backfill] ${result.nativeFailed} native-state write(s) failed — see logs above`,
        );
      }
    }
  } catch (err) {
    console.error(`[writeback-backfill] Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[writeback-backfill] Unexpected error:', err);
  process.exit(1);
});
