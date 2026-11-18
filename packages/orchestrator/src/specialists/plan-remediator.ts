/**
 * Plan remediator (ADR-024) — thin wrapper over the shared early-remediator
 * helper, bound to `kind: 'plan'`.
 *
 * Iterates an already-published plan PR (`helm/plan/<id>`) in-place from operator
 * feedback. See early-remediator.ts for the full design and security notes.
 */
import type { Product } from '@helm/shared';
import type { ProductContext } from './fetch-product-context.js';
import type { SpawnParams } from '../runtime.js';
import {
  buildEarlyRemediatorParams,
  buildEarlyRemediatorPrompt,
  runEarlyRemediation,
  type EarlyRemediationResult,
  type RunEarlyRemediationParams,
} from './early-remediator.js';

/** Builds the plan-remediator prompt (kind: 'plan'). */
export function buildPlanRemediatorPrompt(
  externalId: string,
  product: Product,
  currentPlan: string,
  feedback: string,
  context?: ProductContext,
): string {
  return buildEarlyRemediatorPrompt('plan', externalId, product, currentPlan, feedback, context);
}

/** Builds SpawnParams for the plan remediator (kind: 'plan'). */
export function buildPlanRemediatorParams(
  externalId: string,
  product: Product,
  workspacePath: string,
  currentPlan: string,
  feedback: string,
  context?: ProductContext,
): SpawnParams {
  return buildEarlyRemediatorParams(
    'plan',
    externalId,
    product,
    workspacePath,
    currentPlan,
    feedback,
    context,
  );
}

/** Runs the end-to-end plan remediation (kind: 'plan'). */
export function runPlanRemediation(
  params: Omit<RunEarlyRemediationParams, 'kind'>,
): Promise<EarlyRemediationResult> {
  return runEarlyRemediation({ ...params, kind: 'plan' });
}
