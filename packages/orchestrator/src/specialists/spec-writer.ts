import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowStage } from '@helm/workflow';
import type { Product } from '@helm/shared';
import type { AgentResult, SpawnParams } from '../runtime.js';
import type { ProductContext } from './fetch-product-context.js';
import type { PublishSpecOpts, RunGit, RunGh } from './spec-publisher.js';
import { publishSpecToPR } from './spec-publisher.js';

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
  /** URL of the opened knowledge-repo PR. Present on successful publish. */
  prUrl?: string;
  error?: string;
};

// ── Prompt template ───────────────────────────────────────────────────────────

/**
 * Builds the "## Product Context" section injected into the spec-writer prompt.
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
 * Tracker task injected into the spec-writer prompt.
 * When present, the agent specifies this exact task rather than guessing.
 */
export type SpecWriterTask = {
  title: string;
  body?: string;
};

/**
 * Builds the initial prompt for the spec-writer specialist.
 *
 * @param externalId  The item identifier.
 * @param product     Parsed product config.
 * @param task        Optional task fetched from the issue tracker (title + body).
 *                    When provided, a "## Task" section is injected so the agent
 *                    specifies the real task instead of inventing a placeholder.
 * @param context     Optional product context (README, agent instructions).
 *                    When provided, a "## Product Context" section is injected
 *                    so the agent understands the product domain.
 */
export function buildSpecWriterPrompt(
  externalId: string,
  product: Product,
  task?: SpecWriterTask,
  context?: ProductContext,
): string {
  const contextSection =
    context && (context.readme || context.agentMd) ? buildContextSection(product, context) : '';

  const taskSection = task
    ? [
        '## Task',
        '',
        `**Title:** ${task.title}`,
        '',
        task.body?.trim() || '(no description provided)',
        '',
        '---',
        '',
      ].join('\n')
    : '';

  const taskInstruction = task
    ? `Your task: write a specification for item ${externalId} based on the task described above.`
    : `Your task: write a specification for item ${externalId}.`;

  return `You are the spec writer for the product "${product.product.name}".

${contextSection}${taskSection}${taskInstruction}

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

IMPORTANT: Write the file to the path \`specs/${externalId}.md\` relative to your
current working directory. Create the \`specs/\` directory if it does not exist.
Do not ask for confirmation before writing — create the file directly.

Item: ${externalId}
Product: ${product.product.slug}`;
}

/**
 * Builds SpawnParams for the spec-writer specialist.
 *
 * @param context  Optional product context — passed to buildSpecWriterPrompt.
 * @param task     Optional task fetched from the tracker — passed to buildSpecWriterPrompt.
 */
export function buildSpecWriterParams(
  externalId: string,
  product: Product,
  workdir: string,
  context?: ProductContext,
  task?: SpecWriterTask,
): SpawnParams {
  return {
    specialistId: 'spec-writer',
    prompt: buildSpecWriterPrompt(externalId, product, task, context),
    workdir,
    productSlug: product.product.slug,
    externalId,
    model: product.specialists['spec-writer'].model,
  };
}

// ── Publish options ───────────────────────────────────────────────────────────

/**
 * Options that enable the publish-to-knowledge-repo step.
 * When absent, the spec is written locally but not published.
 */
export type SpecPublishOptions = {
  product: Product;
  githubToken: string;
  /** Injectable git runner — defaults to git via execFile. For testing. */
  runGit?: RunGit;
  /** Injectable gh runner — defaults to gh via execFile. For testing. */
  runGh?: RunGh;
};

// ── Post-completion handler ───────────────────────────────────────────────────

/**
 * Runs after the agent session completes.
 *
 * On success:
 *   1. Verifies specs/{externalId}.md was created in workdir.
 *   2. If publishOpts provided: publishes spec to knowledge repo as a PR.
 *   3. Transitions the item discovery → spec-draft.
 *      (Transition happens after PR is opened so the stage accurately reflects
 *       that the spec is under review.)
 *
 * On agent error, missing spec file, or publish failure:
 *   Returns an error result without transitioning.
 */
export async function handleSpecWriterResult(
  externalId: string,
  agentResult: AgentResult,
  workdir: string,
  transition: ItemTransitionFn,
  publishOpts?: SpecPublishOptions,
): Promise<SpecWriterResult> {
  if (agentResult.status !== 'done') {
    // Log diagnostics server-side (stderr content, timeout details, etc.) so
    // operators can investigate without exposing internal details to callers.
    if (agentResult.finalOutput) {
      console.error('[spec-writer] Agent failure details', {
        externalId,
        status: agentResult.status,
        finalOutput: agentResult.finalOutput,
      });
    }
    return {
      transitioned: false,
      error: `Agent ended with status '${agentResult.status}'`,
    };
  }

  const specPath = join(workdir, 'specs', `${externalId}.md`);
  try {
    await access(specPath);
  } catch {
    // Surface what the agent reported so we can see WHY it didn't write the
    // spec (wrong path, confusion, asked a question, etc.) instead of a blind
    // "not found".
    // Log the agent's final output server-side so operators can diagnose WHY
    // the spec was not created (wrong path, confusion, pending question, etc.).
    // Do NOT include finalOutput in the returned error: with product context
    // injected, it may contain fragments of README/AGENT.md content.
    console.error('[spec-writer] Spec file missing after agent run', {
      externalId,
      specPath,
      agentFinalOutput: agentResult.finalOutput,
    });
    return {
      transitioned: false,
      error: `spec file not found at ${specPath} — agent did not create it`,
    };
  }

  // ── Publish step (optional) ───────────────────────────────────────────────
  let prUrl: string | undefined;
  if (publishOpts) {
    const publishInput: PublishSpecOpts = {
      externalId,
      product: publishOpts.product,
      specPath,
      githubToken: publishOpts.githubToken,
    };
    try {
      const result = await publishSpecToPR(publishInput, publishOpts.runGit, publishOpts.runGh);
      prUrl = result.prUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[spec-writer] Publish step failed', { externalId, error: message });
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
      toStage: 'spec-draft',
      triggeredBy: 'agent:spec-writer',
      note: `Spec written to specs/${externalId}.md${prUrl ? ` — PR: ${prUrl}` : ''}`,
    });
    return { transitioned: true, newStage: updated.currentStage, prUrl };
  } catch (err) {
    return {
      transitioned: false,
      error: `transition failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
