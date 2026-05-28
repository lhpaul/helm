/**
 * Reviewer fan-out specialist — spawns code, security, and test reviewers in
 * parallel on the open implementation PR when an item reaches `code-review`.
 *
 * Design decisions (see ADR-017 for full rationale):
 * - Three isolated workspaces (one per reviewer kind) provisioned in parallel.
 * - Promise.allSettled for spawn+wait — all three run concurrently; a single
 *   reviewer failure does not cancel the others.
 * - Orchestrator posts PR comments (not agents) — GITHUB_TOKEN never enters
 *   agent subprocesses.
 * - Single-pusher invariant: only the code-reviewer may push patches (TODO 19b);
 *   security and test reviewers are comment-only by design.
 * - Item stays in code-review — no transition in this session (Session 19c decides
 *   the next move based on review findings severity).
 * - costUsd = sum of all reviewer costs (all three ran in parallel, all were paid for).
 * - durationMs = max of reviewer durations (represents total wall-clock time).
 */
import { readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Product } from '@helm/shared';
import type { AgentResult, IAgentRuntime, SpawnParams } from '../runtime.js';
import { provisionCodeWorkspace } from './code-workspace.js';
import { postPRComment } from './pr-helpers.js';
import type { RunGit, RunGh } from './git-helpers.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewerKind = 'code' | 'security' | 'test';

export const REVIEWER_KINDS: readonly ReviewerKind[] = ['code', 'security', 'test'] as const;

/** 10 minutes per reviewer — covers reading codebase + generating structured review. */
export const REVIEWER_TIMEOUT_MS = 10 * 60 * 1_000;

export type ReviewerResult = {
  kind: ReviewerKind;
  status: 'done' | 'error' | 'cancelled';
  costUsd: number;
  durationMs: number;
  commentPosted: boolean;
  error?: string;
};

export type ReviewerFanoutResult = {
  reviewerResults: ReviewerResult[];
  prUrl: string;
  /** 'error' if ANY reviewer failed or any comment failed to post. */
  status: 'done' | 'error';
  /** Sum of all reviewer costs (paid for all three in parallel). */
  costUsd: number;
  /** Max of all reviewer durations (parallel wall-clock). */
  durationMs: number;
  error?: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

// Map ReviewerKind → product.specialists key
const SPECIALIST_CONFIG_KEY: Record<
  ReviewerKind,
  'code_reviewer' | 'security_reviewer' | 'test_reviewer'
> = {
  code: 'code_reviewer',
  security: 'security_reviewer',
  test: 'test_reviewer',
};

// ── buildReviewerParams ───────────────────────────────────────────────────────

/**
 * Builds SpawnParams for a reviewer specialist.
 *
 * NOTE (19a): the prompt is a stub that instructs the agent to write a minimal
 * review.md. In 19b this will be replaced with a real structured review prompt.
 */
export function buildReviewerParams(
  kind: ReviewerKind,
  externalId: string,
  product: Product,
  workspacePath: string,
  prUrl: string,
): SpawnParams {
  const specialistCfg = product.specialists[SPECIALIST_CONFIG_KEY[kind]];
  const specialistId = `${kind}-reviewer`;

  // NOTE (19a stub): minimal prompt to produce a review.md file.
  // In 19b this will be replaced with a real structured review prompt that
  // inspects the diff, considers security/tests/code quality respectively, and
  // produces findings with severity ratings.
  const prompt = [
    `You are Helm's ${kind} reviewer specialist. Your task is to review item \`${externalId}\` in the \`${product.product.name}\` product.`,
    '',
    `The implementation PR is available at: ${prUrl}`,
    '',
    'The working directory is a shallow clone of the code repository on the implementation branch.',
    '',
    '**Your task (19a stub):**',
    `Write a file named \`review.md\` in the working directory with a brief review summary from the ${kind} reviewer perspective.`,
    '',
    'The review.md must contain at minimum:',
    `- A heading: \`# ${kind.charAt(0).toUpperCase() + kind.slice(1)} Review: ${externalId}\``,
    '- A one-paragraph summary of your findings.',
    '- A `## Status` section with either `APPROVED` or `CHANGES_REQUESTED`.',
    '',
    'Do not commit or push — the orchestrator handles posting your review.md as a PR comment.',
  ].join('\n');

  return {
    specialistId,
    prompt,
    workdir: workspacePath,
    productSlug: product.product.slug,
    externalId,
    model: specialistCfg.model,
    permissionMode: 'acceptEdits',
    timeoutMs: REVIEWER_TIMEOUT_MS,
  };
}

// ── handleReviewerResult ──────────────────────────────────────────────────────

/**
 * Post-completion handler for a single reviewer.
 *
 * 1. Checks agent status.
 * 2. Reads review.md from workspacePath (falls back to a placeholder if missing).
 * 3. Posts the review content as a PR comment.
 * 4. For code-reviewer: TODO (19b) — check for staged patches and push to impl branch.
 *
 * Never throws; all errors are captured in ReviewerResult.error.
 */
export async function handleReviewerResult(
  kind: ReviewerKind,
  externalId: string,
  agentResult: AgentResult,
  workspacePath: string,
  prUrl: string,
  githubToken: string,
  runGh?: RunGh,
): Promise<ReviewerResult> {
  const baseResult = {
    kind,
    costUsd: agentResult.totalCostUsd,
    durationMs: agentResult.durationMs,
  };

  if (agentResult.status !== 'done') {
    return {
      ...baseResult,
      status: agentResult.status,
      commentPosted: false,
      error: `Agent finished with status '${agentResult.status}'`,
    };
  }

  // Read review.md — fall back to a placeholder if the agent didn't write one.
  let reviewContent: string;
  try {
    reviewContent = await readFile(join(workspacePath, 'review.md'), 'utf-8');
  } catch {
    reviewContent = [
      `# ${kind.charAt(0).toUpperCase() + kind.slice(1)} Review: ${externalId}`,
      '',
      '_No review.md was produced by the reviewer agent._',
      '',
      '## Status',
      '',
      'CHANGES_REQUESTED',
    ].join('\n');
  }

  // Post the review content as a PR comment.
  try {
    await postPRComment({ prUrl, body: reviewContent, githubToken }, runGh);
  } catch (err) {
    return {
      ...baseResult,
      status: 'error',
      commentPosted: false,
      error: `Failed to post PR comment: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // TODO (19b): For code-reviewer, check for staged patches and push to impl branch.

  return {
    ...baseResult,
    status: 'done',
    commentPosted: true,
  };
}

// ── fanoutReviewers ───────────────────────────────────────────────────────────

/**
 * Orchestrates the full reviewer fan-out for one item:
 *   1. Provisions 3 isolated workspaces (one per reviewer kind) using provisionCodeWorkspace.
 *   2. Spawns all 3 reviewer agents in parallel via Promise.allSettled.
 *   3. Handles each result (reads review.md, posts PR comment).
 *   4. Cleans up all workspaces in a finally block.
 *   5. Returns an aggregated result.
 *
 * The item is NOT transitioned — it stays in code-review.
 * The remediation gate (Session 19c) decides the next move.
 *
 * costUsd = sum of all reviewer costs (all three ran in parallel, all were paid for).
 * durationMs = max of reviewer durations (represents total wall-clock time).
 */
export async function fanoutReviewers(
  externalId: string,
  product: Product,
  prUrl: string,
  githubToken: string,
  runtime: IAgentRuntime,
  runGit?: RunGit,
  runGh?: RunGh,
): Promise<ReviewerFanoutResult> {
  const codeRepo = product.code_repos[0];
  if (!codeRepo) {
    return {
      reviewerResults: [],
      prUrl,
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: 'fanoutReviewers requires at least one code_repo in product config',
    };
  }

  // Provision all 3 workspaces in parallel.
  const provisionResults = await Promise.allSettled(
    REVIEWER_KINDS.map((kind) =>
      provisionCodeWorkspace({ externalId, codeRepo, githubToken }, runGit).then((result) => ({
        kind,
        workspacePath: result.workspacePath,
      })),
    ),
  );

  // Collect provisioned workspace paths and detect failures.
  const workspacePaths: Map<ReviewerKind, string> = new Map();
  const provisionErrors: string[] = [];

  for (let i = 0; i < provisionResults.length; i++) {
    const result = provisionResults[i]!;
    const kind = REVIEWER_KINDS[i]!;
    if (result.status === 'fulfilled') {
      workspacePaths.set(kind, result.value.workspacePath);
    } else {
      provisionErrors.push(
        `[${kind}]: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  if (provisionErrors.length > 0) {
    // Clean up any workspaces that did provision successfully.
    await Promise.allSettled(
      [...workspacePaths.values()].map((p) => rm(p, { recursive: true, force: true })),
    );
    return {
      reviewerResults: [],
      prUrl,
      status: 'error',
      costUsd: 0,
      durationMs: 0,
      error: `Failed to provision reviewer workspaces: ${provisionErrors.join('; ')}`,
    };
  }

  // All workspaces provisioned — spawn all 3 agents in parallel.
  const reviewerResults: ReviewerResult[] = [];

  try {
    const spawnResults = await Promise.allSettled(
      REVIEWER_KINDS.map(async (kind) => {
        const workspacePath = workspacePaths.get(kind)!;
        const params = buildReviewerParams(kind, externalId, product, workspacePath, prUrl);
        const session = await runtime.spawn(params);
        const agentResult = await session.wait();
        const reviewerResult = await handleReviewerResult(
          kind,
          externalId,
          agentResult,
          workspacePath,
          prUrl,
          githubToken,
          runGh,
        );
        return reviewerResult;
      }),
    );

    for (const spawnResult of spawnResults) {
      if (spawnResult.status === 'fulfilled') {
        reviewerResults.push(spawnResult.value);
      } else {
        // An unexpected throw from spawn/wait/handle — wrap in a ReviewerResult.
        // This path is a safety net; handleReviewerResult is designed to never throw.
        const err = spawnResult.reason;
        reviewerResults.push({
          kind: 'code', // placeholder — shouldn't happen in practice
          status: 'error',
          costUsd: 0,
          durationMs: 0,
          commentPosted: false,
          error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } finally {
    // Always clean up all provisioned workspaces, even on error.
    await Promise.allSettled(
      [...workspacePaths.values()].map((p) => rm(p, { recursive: true, force: true })),
    );
  }

  // Aggregate results.
  const anyFailed = reviewerResults.some((r) => r.status !== 'done' || !r.commentPosted);
  const totalCostUsd = reviewerResults.reduce((sum, r) => sum + r.costUsd, 0);
  const maxDurationMs = reviewerResults.reduce((max, r) => Math.max(max, r.durationMs), 0);
  const firstError = reviewerResults.find((r) => r.error)?.error;

  return {
    reviewerResults,
    prUrl,
    status: anyFailed ? 'error' : 'done',
    costUsd: totalCostUsd,
    durationMs: maxDurationMs,
    error: anyFailed && firstError ? firstError : undefined,
  };
}
