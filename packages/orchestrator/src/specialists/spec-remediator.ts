/**
 * Spec remediator (ADR-024) — thin wrapper over the shared early-remediator
 * helper, bound to `kind: 'spec'`.
 *
 * Iterates an already-published spec PR (`helm/spec/<id>`) in-place from operator
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

/** Builds the spec-remediator prompt (kind: 'spec'). */
export function buildSpecRemediatorPrompt(
  externalId: string,
  product: Product,
  currentSpec: string,
  feedback: string,
  context?: ProductContext,
): string {
  return buildEarlyRemediatorPrompt('spec', externalId, product, currentSpec, feedback, context);
}

/** Builds SpawnParams for the spec remediator (kind: 'spec'). */
export function buildSpecRemediatorParams(
  externalId: string,
  product: Product,
  workspacePath: string,
  currentSpec: string,
  feedback: string,
  context?: ProductContext,
): SpawnParams {
  return buildEarlyRemediatorParams(
    'spec',
    externalId,
    product,
    workspacePath,
    currentSpec,
    feedback,
    context,
  );
}

/** Runs the end-to-end spec remediation (kind: 'spec'). */
export function runSpecRemediation(
  params: Omit<RunEarlyRemediationParams, 'kind'>,
): Promise<EarlyRemediationResult> {
  return runEarlyRemediation({ ...params, kind: 'spec' });
}
