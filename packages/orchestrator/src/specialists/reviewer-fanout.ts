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
 * - Single-pusher invariant: only the code-reviewer may push patches (ADR-018);
 *   security and test reviewers are comment-only by design.
 * - Item stays in code-review — no transition in this session (Session 19c decides
 *   the next move based on review findings severity).
 * - costUsd = sum of all reviewer costs (all three ran in parallel, all were paid for).
 * - durationMs = max of reviewer durations (represents total wall-clock time).
 * - Spec fetched best-effort before provisioning workspaces; injected into all
 *   three reviewer prompts as a `## Spec` section. Null return or fetch error →
 *   graceful fallback (reviewers run without spec context).
 */
import { readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeRepo, Product } from '@helm/shared';
import type { AgentResult, IAgentRuntime, SpawnParams } from '../runtime.js';
import { provisionReviewerWorkspace, pushReviewerPatches } from './code-workspace.js';
import { fetchSpecForPlan, type FetchFn } from './fetch-product-context.js';
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

/**
 * Canonical format for review.md produced by reviewer agents.
 * Session 19c parses comments posted from this format, matching
 * /\*\*(CRITICAL|HIGH)\*\* · / to detect findings that gate remediation.
 * Matches the agent-hq severity-tag convention for zero-translation parsing.
 *
 * Severity levels: CRITICAL | HIGH | MEDIUM | LOW | INFO
 * Status: APPROVED (no findings ≥ MEDIUM) | CHANGES_REQUESTED
 */
export const REVIEW_MD_FORMAT = `# {Kind} Review: {externalId}

## Summary
<one-paragraph executive summary>

## Findings
- **CRITICAL** · <short finding title>
  <description, impacted files, suggested fix>
- **HIGH** · <…>
- **MEDIUM** · <…>
- **LOW** · <…>
- **INFO** · <…>

Omit severity levels with no findings — do NOT write "None" or "No findings".

## Status
APPROVED | CHANGES_REQUESTED

(Use APPROVED only if there are no findings of severity MEDIUM or above.)`.trim();

// ── buildReviewerParams ───────────────────────────────────────────────────────

/**
 * Builds SpawnParams for a reviewer specialist.
 *
 * Each reviewer kind gets a real domain-focused prompt. If `spec` is provided,
 * it is injected as a `## Spec` section so reviewers can check implementation
 * against acceptance criteria.
 */
export function buildReviewerParams(
  kind: ReviewerKind,
  externalId: string,
  product: Product,
  workspacePath: string,
  prUrl: string,
  spec?: string,
): SpawnParams {
  const specialistCfg = product.specialists[SPECIALIST_CONFIG_KEY[kind]];
  const specialistId = `${kind}-reviewer`;

  const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
  const defaultBranch = product.code_repos[0]?.default_branch ?? 'main';

  const commonHeader = [
    `You are Helm's ${kindLabel} reviewer specialist. Your task is to review item \`${externalId}\`.`,
    '',
    `The implementation PR is available at: ${prUrl} (for context only — do not merge or close it).`,
    '',
    `The working directory is a shallow clone of the \`helm/impl/${externalId}\` implementation branch.`,
    '',
    `To inspect the diff: \`git fetch --depth 1 origin ${defaultBranch}\` then \`git diff origin/${defaultBranch}...HEAD\``,
  ].join('\n');

  const specSection = spec ? ['', '## Spec', '', spec, ''].join('\n') : '';

  const outputInstruction = [
    '',
    '## Output',
    '',
    'Write a file named `review.md` in the working directory using the following format exactly:',
    '',
    REVIEW_MD_FORMAT.replace('{Kind}', kindLabel).replace('{externalId}', externalId),
    '',
    'Do not commit or push — the orchestrator reads review.md and posts it as a PR comment.',
  ].join('\n');

  let kindSpecificInstructions: string;

  switch (kind) {
    case 'code':
      kindSpecificInstructions = [
        '',
        '**Your task — code quality review:**',
        '- Assess code quality against repository conventions (check AGENT.md, CLAUDE.md, README.md in the working directory if present).',
        '- Flag naming issues, structural problems, anti-patterns, dead code, and regression risks.',
        '- Identify missing or inadequate error handling.',
        '- Assess whether the implementation matches the spec requirements (if a spec is provided above).',
        '',
        '**Applying mechanical fixes (code reviewer only):**',
        'If you identify mechanical, low-risk fixes (typos, formatting, dead-code removal, obvious simplifications without logic changes), apply them directly to the files in the working directory. The orchestrator will commit and push. For non-mechanical or invasive changes, surface them as findings only — do NOT modify files.',
      ].join('\n');
      break;

    case 'security':
      kindSpecificInstructions = [
        '',
        '**Your task — security review:**',
        '- Identify injection vulnerabilities (SQL, command, path traversal, template).',
        '- Check authentication and authorization controls.',
        '- Look for secrets or credentials embedded in code.',
        '- Assess input validation for externally-controlled data.',
        '- Check for insecure dependencies, unsafe permissions, and information leaks.',
        '',
        '**Do not modify any files in the working directory.** Surface all findings in review.md only. The orchestrator does not push changes from security or test reviewers.',
      ].join('\n');
      break;

    case 'test':
      kindSpecificInstructions = [
        '',
        '**Your task — test coverage review:**',
        '- Assess test coverage against Acceptance Criteria in the spec (if provided above).',
        '- Identify edge cases and error paths not covered by existing tests.',
        '- Evaluate test quality: are assertions meaningful, or are they trivial/tautological?',
        '- Flag excessive mocking that may hide real bugs.',
        '- Identify tests that may be flaky (time-dependent, order-dependent, environment-dependent).',
        '',
        '**Do not modify any files in the working directory.** Surface all findings in review.md only. The orchestrator does not push changes from security or test reviewers.',
      ].join('\n');
      break;
  }

  const prompt = [commonHeader, specSection, kindSpecificInstructions, outputInstruction].join(
    '\n',
  );

  return {
    specialistId,
    prompt,
    workdir: workspacePath,
    productSlug: product.product.slug,
    externalId,
    model: specialistCfg.model,
    permissionMode: 'bypassPermissions',
    timeoutMs: REVIEWER_TIMEOUT_MS,
  };
}

// ── handleReviewerResult ──────────────────────────────────────────────────────

/**
 * Post-completion handler for a single reviewer.
 *
 * 1. Checks agent status.
 * 2. Reads review.md from workspacePath (falls back to a placeholder if missing).
 * 3. For code-reviewer only: calls pushReviewerPatches — if patches were applied,
 *    appends the commit SHA to the review comment body.
 * 4. Posts the review content as a PR comment.
 * 5. If the push failed: returns status 'error' with commentPosted: true.
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
  codeRepo: CodeRepo,
  runGh?: RunGh,
  runGit?: RunGit,
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

  // For code-reviewer only: attempt to push any mechanical fixes.
  let pushError: string | undefined;
  if (kind === 'code') {
    try {
      const pushResult = await pushReviewerPatches(
        { externalId, codeRepo, workspacePath, githubToken },
        runGit,
      );
      if (pushResult.pushed && pushResult.commitSha) {
        reviewContent += `\n\n---\n🤖 _Code-reviewer applied mechanical fixes — commit \`${pushResult.commitSha}\`_`;
      }
    } catch (err) {
      console.error('[reviewer-fanout] pushReviewerPatches failed:', err);
      pushError = err instanceof Error ? err.message : String(err);
    }
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

  // If the push failed (code reviewer), report error — comment was still posted.
  if (pushError !== undefined) {
    return {
      ...baseResult,
      status: 'error',
      commentPosted: true,
      error: `Comment posted but push failed: ${pushError}`,
    };
  }

  return {
    ...baseResult,
    status: 'done',
    commentPosted: true,
  };
}

// ── fanoutReviewers ───────────────────────────────────────────────────────────

/**
 * Orchestrates the full reviewer fan-out for one item:
 *   1. Fetches spec best-effort (injected into all three reviewer prompts).
 *   2. Provisions 3 isolated workspaces (one per reviewer kind) using provisionReviewerWorkspace.
 *   3. Spawns all 3 reviewer agents in parallel via Promise.allSettled.
 *   4. Handles each result (reads review.md, pushes patches for code-reviewer, posts PR comment).
 *   5. Cleans up all workspaces in a finally block.
 *   6. Returns an aggregated result.
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
  fetchFn?: FetchFn,
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

  // Best-effort spec fetch — reviewers get context but dispatch is not blocked.
  let spec: string | undefined;
  try {
    const fetched = await fetchSpecForPlan(product, externalId, githubToken, fetchFn ?? fetch);
    spec = fetched ?? undefined;
  } catch (err) {
    console.warn(
      '[fanout] Spec fetch failed, continuing without spec:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Provision all 3 workspaces in parallel.
  // provisionReviewerWorkspace clones helm/impl/{externalId} directly from the
  // remote, so each reviewer workspace contains the real implementation code.
  const provisionResults = await Promise.allSettled(
    REVIEWER_KINDS.map((kind) =>
      provisionReviewerWorkspace({ externalId, codeRepo, githubToken }, runGit).then((result) => ({
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
        const params = buildReviewerParams(kind, externalId, product, workspacePath, prUrl, spec);
        const session = await runtime.spawn(params);
        const agentResult = await session.wait();
        const reviewerResult = await handleReviewerResult(
          kind,
          externalId,
          agentResult,
          workspacePath,
          prUrl,
          githubToken,
          codeRepo,
          runGh,
          runGit,
        );
        return reviewerResult;
      }),
    );

    for (let i = 0; i < spawnResults.length; i++) {
      const spawnResult = spawnResults[i]!;
      const kind = REVIEWER_KINDS[i]!;
      if (spawnResult.status === 'fulfilled') {
        reviewerResults.push(spawnResult.value);
      } else {
        // An unexpected throw from spawn/wait/handle — wrap in a ReviewerResult.
        // This path is a safety net; handleReviewerResult is designed to never throw.
        const err = spawnResult.reason;
        reviewerResults.push({
          kind,
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
