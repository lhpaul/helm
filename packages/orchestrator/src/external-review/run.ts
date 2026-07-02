import type { Product } from '@helm/shared';
import { parseGitHubRepoUrl } from '../specialists/fetch-product-context.js';
import {
  createHaystackExternalReviewAdapter,
  type HaystackAdapterDeps,
} from './haystack/adapter.js';
import type { ExternalReviewContext, ExternalReviewResult } from './types.js';

/** Parses `owner/repo#N` from a GitHub PR URL. */
export function parsePullRequestRef(
  prUrl: string,
): { owner: string; repo: string; prNumber: number } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, prNumber: Number(match[3]) };
}

export type RunExternalReviewDeps = HaystackAdapterDeps;

/**
 * Runs the configured external reviewer when `review.external.provider` is set.
 */
export async function runExternalReviewIfConfigured(
  product: Product,
  prUrl: string,
  deps?: RunExternalReviewDeps,
): Promise<ExternalReviewResult> {
  const provider = product.review?.external?.provider;
  if (!provider) {
    return { status: 'skipped', reason: 'not_configured' };
  }

  const codeRepo = product.code_repos[0];
  if (!codeRepo) {
    return { status: 'skipped', reason: 'unavailable' };
  }

  const parsedRepo = parseGitHubRepoUrl(codeRepo.url);
  const prRef = parsePullRequestRef(prUrl);
  if (!parsedRepo || !prRef) {
    return { status: 'skipped', reason: 'unavailable' };
  }

  const ctx: ExternalReviewContext = {
    owner: prRef.owner,
    repo: prRef.repo,
    prNumber: prRef.prNumber,
    prUrl,
    defaultBranch: codeRepo.default_branch,
  };

  if (provider === 'haystack') {
    const adapter = createHaystackExternalReviewAdapter(product, deps);
    return adapter.reviewPullRequest(ctx);
  }

  return { status: 'skipped', reason: 'not_implemented' };
}
