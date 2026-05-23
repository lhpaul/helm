import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { AgentResult, SpawnParams } from '../runtime.js';

// ── Minimal transition interface ──────────────────────────────────────────────
// Avoids a dependency on @helm/api internals. ItemStore.transition satisfies this.

export type ItemTransitionFn = (input: {
  externalId: string;
  toStage: WorkflowStage;
  triggeredBy: string;
  note?: string;
}) => Promise<{ currentStage: WorkflowStage }>;

// ── Spec writer result ────────────────────────────────────────────────────────

export type SpecWriterResult = {
  transitioned: boolean;
  newStage?: WorkflowStage;
  error?: string;
};

// ── Prompt template ───────────────────────────────────────────────────────────

/**
 * Builds the initial prompt for the spec-writer specialist.
 * The template is intentionally minimal for v0 — Sesión 10 will refine it.
 */
export function buildSpecWriterPrompt(externalId: string, product: Product): string {
  return `You are the spec writer for the product "${product.product.name}".

Your task: write a specification for item ${externalId}.

Steps:
1. Review any existing context in the working directory.
2. Create the file specs/${externalId}.md with this structure:

# ${externalId} — Specification

## Context
<!-- Describe the problem or feature this item addresses -->

## Acceptance Criteria
<!-- List measurable, testable criteria -->

## Technical Notes
<!-- Architecture, constraints, dependencies -->

3. Confirm once the file is written.

Working directory: {workdir}
Item: ${externalId}
Product: ${product.product.slug}`;
}

/**
 * Builds SpawnParams for the spec-writer specialist.
 */
export function buildSpecWriterParams(
  externalId: string,
  product: Product,
  workdir: string,
): SpawnParams {
  return {
    specialistId: 'spec-writer',
    prompt: buildSpecWriterPrompt(externalId, product),
    workdir,
    productSlug: product.product.slug,
    externalId,
    model: product.specialists.spec_writer.model,
  };
}

// ── Post-completion handler ───────────────────────────────────────────────────

/**
 * Runs after the agent session completes.
 *
 * On success:
 *   1. Verifies specs/{externalId}.md was created in workdir.
 *   2. Transitions the item discovery → spec-draft.
 *
 * On agent error or missing file:
 *   Returns an error result without transitioning.
 */
export async function handleSpecWriterResult(
  externalId: string,
  agentResult: AgentResult,
  workdir: string,
  transition: ItemTransitionFn,
): Promise<SpecWriterResult> {
  if (agentResult.status !== 'done') {
    return {
      transitioned: false,
      // Include finalOutput (which carries captured [stderr] on spawn/crash
      // failures) so the operator can diagnose why the agent failed.
      error: agentResult.finalOutput
        ? `Agent ended with status '${agentResult.status}': ${agentResult.finalOutput}`
        : `Agent ended with status '${agentResult.status}'`,
    };
  }

  const specPath = join(workdir, 'specs', `${externalId}.md`);
  try {
    await access(specPath);
  } catch {
    return {
      transitioned: false,
      error: `spec file not found at ${specPath} — agent did not create it`,
    };
  }

  try {
    const updated = await transition({
      externalId,
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
      note: `Spec written to specs/${externalId}.md`,
    });
    return { transitioned: true, newStage: updated.currentStage };
  } catch (err) {
    return {
      transitioned: false,
      error: `transition failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
