import type { Product } from '@helm/shared';
import type { RemediateSeverity } from './remediate-gate.js';

/** Resolved review-loop settings from product.yaml (ADR-036, ADR-037, ADR-042). */
export type ReviewLoopConfig = {
  maxCycles: number;
  /** Lifetime budget across dispatches (ADR-042). */
  maxCyclesCumulative: number;
  noProgressCycles: number;
  adjudicationEnabled: boolean;
  remediateSeverity: RemediateSeverity;
  earlyLoopEnabled: boolean;
};

const DEFAULT_MAX_CYCLES = 5;
const DEFAULT_NO_PROGRESS_CYCLES = 2;
/**
 * Headroom for legitimate multi-dispatch work (rebases, follow-up review rounds)
 * before the lifetime budget calls non-convergence (ADR-042).
 */
const DEFAULT_CUMULATIVE_MULTIPLIER = 3;

/** Reads `review.loop` with ADR-036 defaults when omitted. */
export function resolveReviewLoopConfig(product: Product): ReviewLoopConfig {
  const loop = product.review?.loop;
  const specialistConfigured = product.specialists['review-adjudicator'] !== undefined;
  const explicitlyDisabled = loop?.adjudication?.enabled === false;
  const maxCycles = loop?.max_cycles ?? DEFAULT_MAX_CYCLES;

  return {
    maxCycles,
    maxCyclesCumulative: loop?.max_cycles_cumulative ?? maxCycles * DEFAULT_CUMULATIVE_MULTIPLIER,
    noProgressCycles: loop?.stop_rule?.no_progress_cycles ?? DEFAULT_NO_PROGRESS_CYCLES,
    adjudicationEnabled: specialistConfigured && !explicitlyDisabled,
    remediateSeverity: loop?.remediate_severity ?? 'critical_high',
    earlyLoopEnabled: product.review?.early_loop?.enabled ?? false,
  };
}
