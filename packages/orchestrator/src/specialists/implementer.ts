/**
 * Implementer specialist — spawns a Claude Code agent to write production code
 * based on the approved implementation plan from the knowledge repo.
 *
 * Two-phase transition:
 *   1. `plan-ready → in-development` before the agent runs.
 *   2. `in-development → code-review` after the implementation PR is opened.
 *
 * The agent subprocess runs with `bypassPermissions` (it needs to write code,
 * install dependencies, run tests, etc.) but with GITHUB_TOKEN scrubbed from
 * its environment (the token is used for workspace provisioning and PR creation
 * by the orchestrator, not the agent itself).
 */
import type { WorkflowStage } from '@helm/workflow';
import type { Product, CodeRepo } from '@helm/shared';
import type { AgentResult, SpawnParams } from '../runtime.js';
import type { ProductContext } from './fetch-product-context.js';
import type { ItemTransitionFn } from './spec-writer.js';
import type { RunGit, RunGh } from './git-helpers.js';

export type { ItemTransitionFn };

// ── Timeout ───────────────────────────────────────────────────────────────────

/**
 * Default timeout for the implementer specialist.
 *
 * 20 minutes covers: code generation, running the full test suite once or
 * twice (fixing failures), and lint passes.  Adjust via `params.timeoutMs`
 * if a particular repo's CI is known to be slower.
 */
export const IMPLEMENTER_TIMEOUT_MS = 20 * 60 * 1_000; // 20 minutes

// ── Result type ───────────────────────────────────────────────────────────────

export type ImplementerResult = {
  transitioned: boolean;
  newStage?: WorkflowStage;
  /** URL of the code-repo PR opened by the publish step. Present on success. */
  prUrl?: string;
  error?: string;
};

// ── Publish options ───────────────────────────────────────────────────────────

export type ImplementerPublishOptions = {
  product: Product;
  githubToken: string;
  runGit?: RunGit;
  runGh?: RunGh;
};

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the "## Product Context" section for the implementer prompt.
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
 * Builds the initial prompt for the implementer specialist.
 *
 * The approved plan is injected as the primary input — the agent translates it
 * directly into production code in the current working directory.
 *
 * @param externalId  The item identifier.
 * @param product     Parsed product config.
 * @param plan        Content of plans/{externalId}.md from the knowledge repo.
 * @param context     Optional product context (README, agent instructions).
 */
function buildImplementerPrompt(
  externalId: string,
  product: Product,
  plan: string,
  context?: ProductContext,
): string {
  const lines: string[] = [
    `You are Helm's implementer specialist. Your task is to implement item \`${externalId}\` in the \`${product.product.name}\` product.`,
    '',
    'The working directory is the code repository. Implement the approved plan below by writing, editing, or deleting files as required. Follow the repository conventions (language, style, tests, etc.).',
    '',
    '**Implementation rules:**',
    '- Make only the changes required by the plan. Do not refactor unrelated code.',
    '- If the plan specifies tests, write them.',
    '- Do not commit or push — that is handled by the orchestrator after you finish.',
    '',
    '**Verification (required before finishing):**',
    '1. Locate the test and lint commands for this repository.',
    '   Check in order: `AGENT.md`, `CLAUDE.md`, `README.md`, `package.json` scripts,',
    '   `Makefile`. Common patterns: `pnpm test`, `npm test`, `cargo test`,',
    '   `pytest`, `go test ./...`, `make test`, `pnpm lint`, `eslint`.',
    '2. Run the tests. If any tests fail **because of changes you made**, fix them',
    '   before finishing. Pre-existing failures unrelated to the plan do not need',
    '   to be fixed — but document them so reviewers can distinguish them.',
    '3. Run the linter. Fix any lint errors your changes introduced.',
    '4. Repeat until tests pass and lint is clean for the code you changed.',
    '5. **If you cannot reach a green state** (e.g. a pre-existing failure blocks the',
    '   test runner, or a fix would exceed the plan scope), state this explicitly in',
    '   your final summary:',
    '   - What is failing and the exact error message',
    '   - Whether the failure is pre-existing or introduced by your changes',
    '   - What you attempted to fix it',
    '   Do NOT claim success if tests are still failing because of your changes.',
    '',
  ];

  if (context) {
    lines.push(buildContextSection(product, context));
  }

  lines.push('## Approved Implementation Plan', '', plan, '');

  return lines.join('\n');
}

/**
 * Builds the `SpawnParams` for the implementer specialist.
 *
 * Key differences from spec-writer / plan-writer:
 * - `permissionMode: 'bypassPermissions'` — the agent needs to run shell
 *   commands (test runners, package managers, etc.) without prompting.
 * - `timeoutMs: 15 * 60 * 1000` — implementation typically takes longer.
 * - `env` does NOT include GITHUB_TOKEN (scrubbed by buildSubprocessEnv in the
 *   runtime — the agent must not have direct git push access).
 */
export function buildImplementerParams(
  externalId: string,
  product: Product,
  workspacePath: string,
  plan: string,
  context?: ProductContext,
): SpawnParams {
  const specialistCfg = product.specialists.implementer;
  return {
    specialistId: 'implementer',
    prompt: buildImplementerPrompt(externalId, product, plan, context),
    workdir: workspacePath,
    productSlug: product.product.slug,
    externalId,
    model: specialistCfg.model,
    permissionMode: 'bypassPermissions',
    timeoutMs: IMPLEMENTER_TIMEOUT_MS,
  };
}

// ── Result handler ────────────────────────────────────────────────────────────

/**
 * Post-completion handler for the implementer specialist.
 *
 * Responsibilities:
 *   1. If the agent succeeded and a `publishOpts` was provided, call
 *      `openCodePR` to commit, push, and open the implementation PR.
 *   2. Transition the item to `code-review` on success.
 *   3. Return a structured result regardless of outcome.
 *
 * NOTE: `plan-ready → in-development` is handled by the dispatcher BEFORE
 * spawning the agent (not here). This handler only manages the post-agent step.
 */
export async function handleImplementerResult(
  externalId: string,
  agentResult: AgentResult,
  workspacePath: string,
  codeRepo: CodeRepo,
  transition: ItemTransitionFn,
  publishOpts?: ImplementerPublishOptions,
): Promise<ImplementerResult> {
  // Import here to avoid a circular dependency at module load time.
  const { openCodePR } = await import('./code-workspace.js');

  if (agentResult.status !== 'done') {
    console.error('[implementer] Agent did not complete successfully', {
      externalId,
      status: agentResult.status,
    });
    return {
      transitioned: false,
      error: `Agent finished with status '${agentResult.status}'`,
    };
  }

  // ── Open implementation PR ────────────────────────────────────────────────
  let prUrl: string | undefined;
  if (publishOpts) {
    const { githubToken, runGit, runGh } = publishOpts;
    try {
      const prResult = await openCodePR(
        {
          externalId,
          codeRepo,
          workspacePath,
          githubToken,
          prTitle: `feat: implement ${externalId}`,
          prBody:
            `Implementation generated by Helm for item \`${externalId}\` in product \`${publishOpts.product.product.slug}\`.\n\n` +
            `Review and merge to advance the item to **code-review**.`,
        },
        runGit,
        runGh,
      );
      if (prResult.prUrl) {
        prUrl = prResult.prUrl;
      } else {
        // Agent made no changes — nothing to review.
        console.error('[implementer] Agent produced no file changes', { externalId });
        return {
          transitioned: false,
          error: 'Agent produced no file changes in the workspace',
        };
      }
    } catch (err) {
      console.error('[implementer] Failed to open code PR', {
        externalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        transitioned: false,
        error: `Failed to open code PR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Transition to code-review ─────────────────────────────────────────────
  try {
    await transition({
      externalId,
      toStage: 'code-review',
      triggeredBy: 'specialist:implementer',
    });
    return { transitioned: true, newStage: 'code-review', prUrl };
  } catch (err) {
    console.error('[implementer] Failed to transition to code-review', {
      externalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      transitioned: false,
      prUrl,
      error: `Failed to transition to code-review: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
