/**
 * helm list-linear-states — print a Linear team's workflow states (ADR-035).
 *
 * The per-product native-state override (`workflow.native_state_map`) maps Helm
 * stages to Linear workflow-state **ids** (opaque UUIDs, stable across renames).
 * This helper lists the configured product's team states as `id  name  (type)`
 * so an operator can copy the ids into `native_state_map`.
 *
 * Usage:
 *   pnpm --filter @helm/api list-linear-states <productSlug>
 *
 * Required env vars:
 *   HELM_KNOWLEDGE_REPO_PATH    — path to the primary knowledge repo
 *   <api_key_env>               — the env var named by issue_tracker.api_key_env
 *                                 (the Linear PAT) for the product
 *
 * No-op (with a clear message) for non-Linear products.
 */
import { LinearAdapter } from '@helm/adapters';
import { getProductRegistry } from '../services/index.js';
import { isSafeFsPath } from '../services/types.js';
import { TRACKER_WRITE_TIMEOUT_MS, withTimeout } from '../lib/with-timeout.js';

async function main(): Promise<void> {
  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error('Usage: pnpm --filter @helm/api list-linear-states <productSlug>');
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

  let products;
  try {
    products = await getProductRegistry();
  } catch (err) {
    console.error(
      `[list-linear-states] Failed to load product registry: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const product = products.find((p) => p.product.slug === slug);
  if (!product) {
    const known = products.map((p) => p.product.slug).join(', ');
    console.error(`[list-linear-states] Product not found: "${slug}". Known products: ${known}`);
    process.exit(1);
  }

  const { issue_tracker } = product;
  if (issue_tracker.provider !== 'linear') {
    console.error(
      `[list-linear-states] Product "${slug}" uses provider "${issue_tracker.provider}", not linear ` +
        '— native_state_map (by id) is Linear-only.',
    );
    process.exit(1);
  }

  const apiKey = process.env[issue_tracker.api_key_env]?.trim();
  if (!apiKey) {
    console.error(
      `Error: ${issue_tracker.api_key_env} environment variable is not set or blank (required for Linear)`,
    );
    process.exit(1);
  }

  const adapter = new LinearAdapter(issue_tracker, apiKey, { ttlMs: 0 });

  let states;
  try {
    // Bound the Linear API call so a stalled connection can't hang the CLI
    // indefinitely (same posture as the writeback paths). LinearAdapter's fetch
    // has no internal timeout; withTimeout rejects and we exit below.
    states = await withTimeout(
      adapter.listWorkflowStates(),
      TRACKER_WRITE_TIMEOUT_MS,
      'list-linear-states',
    );
  } catch (err) {
    console.error(
      `[list-linear-states] Error fetching states for team "${issue_tracker.team_key}": ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  console.log(
    `Linear team "${issue_tracker.team_key}" workflow states (copy the id into workflow.native_state_map):\n`,
  );
  for (const s of states) {
    console.log(`${s.id}  ${s.name}  (${s.type})`);
  }
}

main().catch((err) => {
  console.error('[list-linear-states] Unexpected error:', err);
  process.exit(1);
});
