import type { Product } from '@helm/shared';

/** Resolved review-loop settings from product.yaml (ADR-036, ADR-037). */
export type ReviewLoopConfig = {
  maxCycles: number;
  noProgressCycles: number;
  adjudicationEnabled: boolean;
};

const DEFAULT_MAX_CYCLES = 5;
const DEFAULT_NO_PROGRESS_CYCLES = 2;

/** Reads `review.loop` with ADR-036 defaults when omitted. */
export function resolveReviewLoopConfig(product: Product): ReviewLoopConfig {
  const loop = product.review?.loop;
  const specialistConfigured = product.specialists['review-adjudicator'] !== undefined;
  const explicitlyDisabled = loop?.adjudication?.enabled === false;

  return {
    maxCycles: loop?.max_cycles ?? DEFAULT_MAX_CYCLES,
    noProgressCycles: loop?.stop_rule?.no_progress_cycles ?? DEFAULT_NO_PROGRESS_CYCLES,
    adjudicationEnabled: specialistConfigured && !explicitlyDisabled,
  };
}
