import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { AgentResult, SpawnParams } from '../runtime.js';
import type { ProductContext } from './fetch-product-context.js';
import type { ItemTransitionFn } from './spec-writer.js';
import type { PublishPlanOpts, RunGit, RunGh } from './spec-publisher.js';
import { publishPlanToPR } from './spec-publisher.js';
import { buildExtraHintsSection } from './extra-hints.js';

// ── Plan writer result ────────────────────────────────────────────────────────

export type PlanWriterResult = {
  transitioned: boolean;
  newStage?: WorkflowStage;
  /** URL of the opened knowledge-repo PR. Present on successful publish. */
  prUrl?: string;
  error?: string;
};

// ── Prompt template ───────────────────────────────────────────────────────────

/**
 * Builds the "## Product Context" section injected into the plan-writer prompt.
 * Identical structure to the spec-writer's context section.
 * Returns an empty string when no context is available.
 */
function buildContextSection(product: Product, context: ProductContext): string {
  const lines: string[] = [
    '## Product Context',
    '',
    `**Product:** ${product.product.name} (slug: \`${product.product.slug}\`)`,
    `**Code repo:** ${product.code_repos[0]?.url ?? 'N/A'} (branch: \`${product.code_repos[0]?.default_branch ?? 'main'}\`)`,
    `**Workflow stages:** ${product.workflow.stages_enabled.join(' → ')}`,
    '',
  ];

  if (context.readme) {
    lines.push('### README', '', context.readme, '');
  }

  if (context.agentMd) {
    lines.push('### Agent Instructions', '', context.agentMd, '');
  }

  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Builds the initial prompt for the plan-writer specialist.
 *
 * The approved spec is injected as the primary input — the agent must not
 * invent requirements; it derives the implementation plan directly from it.
 *
 * @param externalId  The item identifier.
 * @param product     Parsed product config.
 * @param spec        Content of specs/{externalId}.md from the knowledge repo.
 * @param context     Optional product context (README, agent instructions).
 */
export function buildPlanWriterPrompt(
  externalId: string,
  product: Product,
  spec: string,
  context?: ProductContext,
): string {
  const contextSection =
    context && (context.readme || context.agentMd) ? buildContextSection(product, context) : '';

  const hintsSection = buildExtraHintsSection(product.specialists['plan-writer'].extra_hints);

  return `You are the plan writer for the product "${product.product.name}".

${contextSection}Your task: write a technical implementation plan for item ${externalId}.

${hintsSection}The specification has already been written and approved. Use it as your primary input
— do not invent requirements beyond what is described there.

## Specification

${spec}

---

Steps:
1. Review the spec above and any existing context in the working directory.
2. Create the file plans/${externalId}.md with this structure:

# ${externalId} — Implementation Plan

## Overview
<!-- Brief summary of what will be built and why -->

## Implementation Steps
<!-- Ordered, numbered steps with enough detail to execute -->

## Files to Touch
<!-- List the files to create, modify, or delete, with a one-line note for each -->

## Test Strategy
<!-- Unit, integration, and E2E tests to write -->

## Risks / Open Questions
<!-- Uncertainties, blockers, or decisions still pending -->

IMPORTANT: Write the file to the path \`plans/${externalId}.md\` relative to your
current working directory. Create the \`plans/\` directory if it does not exist.
Do not ask for confirmation before writing — create the file directly.

Item: ${externalId}
Product: ${product.product.slug}`;
}

/**
 * Builds SpawnParams for the plan-writer specialist.
 *
 * @param spec     Content of the approved spec — required input for plan generation.
 * @param context  Optional product context — passed to buildPlanWriterPrompt.
 */
export function buildPlanWriterParams(
  externalId: string,
  product: Product,
  workdir: string,
  spec: string,
  context?: ProductContext,
): SpawnParams {
  return {
    specialistId: 'plan-writer',
    prompt: buildPlanWriterPrompt(externalId, product, spec, context),
    workdir,
    productSlug: product.product.slug,
    externalId,
    model: product.specialists['plan-writer'].model,
  };
}

// ── Publish options ───────────────────────────────────────────────────────────

/**
 * Options that enable the publish-to-knowledge-repo step.
 * When absent, the plan is written locally but not published.
 */
export type PlanPublishOptions = {
  product: Product;
  githubToken: string;
  /** Injectable git runner — defaults to git via execFile. For testing. */
  runGit?: RunGit;
  /** Injectable gh runner — defaults to gh via execFile. For testing. */
  runGh?: RunGh;
};

// ── Post-completion handler ───────────────────────────────────────────────────

/**
 * Runs after the plan-writer agent session completes.
 *
 * On success:
 *   1. Verifies plans/{externalId}.md was created in workdir.
 *   2. If publishOpts provided: publishes plan to knowledge repo as a PR.
 *   3. Transitions the item spec-ready → plan-draft.
 *      (Transition happens after PR is opened so the stage accurately reflects
 *       that the plan is under review.)
 *
 * On agent error, missing plan file, or publish failure:
 *   Returns an error result without transitioning.
 */
export async function handlePlanWriterResult(
  externalId: string,
  agentResult: AgentResult,
  workdir: string,
  transition: ItemTransitionFn,
  publishOpts?: PlanPublishOptions,
): Promise<PlanWriterResult> {
  if (agentResult.status !== 'done') {
    if (agentResult.finalOutput) {
      console.error('[plan-writer] Agent failure details', {
        externalId,
        status: agentResult.status,
        hasFinalOutput: true,
        finalOutputChars: agentResult.finalOutput.length,
      });
    }
    return {
      transitioned: false,
      error: `Agent ended with status '${agentResult.status}'`,
    };
  }

  const planPath = join(workdir, 'plans', `${externalId}.md`);
  try {
    await access(planPath);
  } catch {
    // Log the agent's final output server-side so operators can diagnose WHY
    // the plan was not created.  Do NOT include finalOutput in the returned
    // error: the prompt contains the spec content which should not leak to callers.
    console.error('[plan-writer] Plan file missing after agent run', {
      externalId,
      planPath,
      hasAgentFinalOutput: Boolean(agentResult.finalOutput),
      agentFinalOutputChars: agentResult.finalOutput?.length ?? 0,
    });
    return {
      transitioned: false,
      error: `plan file not found at ${planPath} — agent did not create it`,
    };
  }

  // ── Publish step (optional) ───────────────────────────────────────────────
  let prUrl: string | undefined;
  if (publishOpts) {
    const publishInput: PublishPlanOpts = {
      externalId,
      product: publishOpts.product,
      planPath,
      githubToken: publishOpts.githubToken,
    };
    try {
      const result = await publishPlanToPR(publishInput, publishOpts.runGit, publishOpts.runGh);
      prUrl = result.prUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[plan-writer] Publish step failed', { externalId, error: message });
      return {
        transitioned: false,
        error: message,
      };
    }
  }

  // ── Transition (after successful publish or when publish is skipped) ──────
  try {
    const updated = await transition({
      externalId,
      toStage: 'plan-draft',
      triggeredBy: 'agent:plan-writer',
      note: `Plan written to plans/${externalId}.md${prUrl ? ` — PR: ${prUrl}` : ''}`,
    });
    return { transitioned: true, newStage: updated.currentStage, prUrl };
  } catch (err) {
    return {
      transitioned: false,
      error: `transition failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
