/**
 * Remediation specialist — spawned by the dispatcher's remediation gate when a
 * security or test reviewer surfaced CRITICAL/HIGH findings on the open
 * implementation PR (see ADR-019).
 *
 * Structural mirror of the implementer specialist:
 *   - `buildRemediationParams` builds the SpawnParams (prompt + runtime config).
 *   - `handleRemediationResult` runs after the agent finishes: it reads the
 *     agent's `remediation.md`, pushes any file changes to the impl branch as
 *     helm-bot, and posts the summary as a PR comment.
 *
 * Single-pusher invariant (ADR-017/018): remediation runs *sequentially* after
 * the parallel reviewer fan-out, so it is the only writer to the impl branch at
 * its moment in time. It reuses `pushReviewerPatches` with a remediation commit
 * message rather than introducing a second push path.
 *
 * The agent never commits or pushes and never receives GITHUB_TOKEN — the
 * orchestrator owns git/gh, mirroring the reviewer fan-out design.
 */
import { readFile } from 'node:fs/promises';
import type { CodeRepo, Product } from '@helm/shared';
import type { AgentResult, SpawnParams } from '../runtime.js';
import type { ReviewerKind } from './reviewer-fanout.js';
import { pushReviewerPatches, artifactFileFor } from './code-workspace.js';
import { postPRComment } from './pr-helpers.js';
import { sanitizeToken } from './git-helpers.js';
import type { RunGit, RunGh } from './git-helpers.js';
import { buildExtraHintsSection } from './extra-hints.js';

// ── Timeout ───────────────────────────────────────────────────────────────────

/**
 * 15 minutes — between the reviewer (10 min) and implementer (20 min) budgets.
 * Remediation applies mechanical fixes to an existing implementation, so it
 * needs less than a from-scratch implementer run but more than a read-only
 * reviewer.
 */
export const REMEDIATION_TIMEOUT_MS = 15 * 60 * 1_000;

// ── Result type ───────────────────────────────────────────────────────────────

export type RemediationResult = {
  status: 'done' | 'error' | 'cancelled';
  costUsd: number;
  durationMs: number;
  commentPosted: boolean;
  pushed: boolean;
  commitSha?: string;
  error?: string;
};

// ── buildRemediationParams ──────────────────────────────────────────────────

/**
 * Builds SpawnParams for the remediation specialist.
 *
 * The full code, security, and test review bodies are injected (not just the
 * CRITICAL/HIGH counts) so the agent has the context it needs to apply fixes.
 * The gate fired on CRITICAL/HIGH, but the agent may also address MEDIUM
 * findings at its discretion.
 *
 * As of ADR-025 the remediator is the unified safety net behind ALL three
 * reviewers (code, security, test): the code-reviewer gets the first chance to
 * self-apply its mechanical fixes, but any CRITICAL/HIGH it does not fix flows
 * here. The fixes are idempotent — if the code-reviewer already applied a fix,
 * the remediator sees the current branch state and reports a no-op rather than
 * re-applying a redundant diff.
 */
export function buildRemediationParams(
  externalId: string,
  product: Product,
  workspacePath: string,
  prUrl: string,
  findingsByKind: Map<ReviewerKind, string>,
  adjudicationPlan?: string,
): SpawnParams {
  const specialistCfg = product.specialists['code-remediator'];
  const defaultBranch = product.code_repos[0]?.default_branch ?? 'main';

  const reviewSections: string[] = [];
  if (adjudicationPlan?.trim()) {
    reviewSections.push(
      '',
      '## Unified remediation plan (from review-adjudicator)',
      '',
      adjudicationPlan.trim(),
    );
  } else {
    for (const kind of ['code', 'security', 'test'] as const) {
      const body = findingsByKind.get(kind);
      if (body) {
        const label = kind.charAt(0).toUpperCase() + kind.slice(1);
        reviewSections.push('', `## ${label} Review`, '', body);
      }
    }
  }

  const hintsSection = buildExtraHintsSection(specialistCfg.extra_hints);

  // The remediator writes its summary to a SIBLING artifacts directory, OUTSIDE
  // the git clone (ADR-025), so it can never be staged onto the impl branch.
  const artifactPath = artifactFileFor(workspacePath, 'code-remediator');

  const prompt = [
    `You are Helm's remediation specialist. Your task is to remediate review findings on item \`${externalId}\`.`,
    '',
    `The implementation PR is available at: ${prUrl} (for context only — do not merge or close it).`,
    '',
    `The working directory is a shallow clone of the \`helm/impl/${externalId}\` implementation branch, including any mechanical fixes the code-reviewer already pushed.`,
    '',
    `To inspect the diff: \`git fetch --depth 1 origin ${defaultBranch}\` then \`git diff origin/${defaultBranch}...HEAD\``,
    '',
    'The unified remediation plan below (when present) or the raw review sections contain the findings to remediate.',
    'A finding may already be fixed if the code-reviewer self-applied it — inspect the current state of the files before changing anything, and treat an already-satisfied finding as a no-op rather than re-applying it.',
    ...reviewSections,
    '',
    ...(hintsSection ? [hintsSection] : []),
    '**Your task — remediate CRITICAL and HIGH findings:**',
    '- Apply mechanical, low-risk fixes to the files in the working directory that resolve the CRITICAL and HIGH findings.',
    '- You MAY also address MEDIUM findings if the fix is mechanical and low-risk; the gate fired on CRITICAL/HIGH only.',
    '- For findings that require design changes or human judgment (non-mechanical), DO NOT modify files. Document them as "deferred" in your summary so a human can decide.',
    '',
    '## Output',
    '',
    'Write your summary to this exact absolute path with two sections:',
    '',
    `    ${artifactPath}`,
    '',
    '- **Applied:** each fix you made, referencing the original finding (severity + title) and the files touched.',
    '- **Deferred:** each finding you did NOT fix, with a one-line reason (already satisfied, design decision, ambiguous, out of scope).',
    '',
    `Write the summary ONLY to that absolute path — it is outside the working directory on purpose. Do NOT create a \`remediation.md\` inside the working directory, and do not commit or push. The orchestrator reads that file, commits and pushes your source changes, and posts the summary as a PR comment.`,
  ].join('\n');

  return {
    specialistId: 'code-remediator',
    prompt,
    workdir: workspacePath,
    productSlug: product.product.slug,
    externalId,
    model: specialistCfg.model,
    permissionMode: 'bypassPermissions',
    timeoutMs: REMEDIATION_TIMEOUT_MS,
  };
}

// ── handleRemediationResult ──────────────────────────────────────────────────

/**
 * Post-completion handler for the remediation specialist.
 *
 * 1. If the agent did not finish 'done' → return error (push nothing).
 * 2. Read `remediation.md` from the workspace (placeholder fallback if absent).
 * 3. Push file changes to the impl branch via pushReviewerPatches with a
 *    remediation commit message.
 * 4. If pushed, append the commit SHA to the summary body.
 * 5. Post the summary as a PR comment.
 * 6. Return a RemediationResult.
 *
 * Never throws; all errors are captured in RemediationResult.error.
 */
export async function handleRemediationResult(
  externalId: string,
  agentResult: AgentResult,
  workspacePath: string,
  prUrl: string,
  githubToken: string,
  codeRepo: CodeRepo,
  runGit?: RunGit,
  runGh?: RunGh,
): Promise<RemediationResult> {
  const baseResult = {
    costUsd: agentResult.totalCostUsd,
    durationMs: agentResult.durationMs,
  };

  if (agentResult.status !== 'done') {
    return {
      ...baseResult,
      status: agentResult.status,
      commentPosted: false,
      pushed: false,
      error: `Agent finished with status '${agentResult.status}'`,
    };
  }

  // Read the remediation summary from the sibling artifacts directory (ADR-025)
  // — fall back to a placeholder if the agent didn't write one.
  let summaryBody: string;
  try {
    summaryBody = await readFile(artifactFileFor(workspacePath, 'code-remediator'), 'utf-8');
  } catch {
    summaryBody = [
      `# Remediation: ${externalId}`,
      '',
      '_No remediation summary was produced by the remediation agent._',
    ].join('\n');
  }

  // Push any file changes to the impl branch (single-pusher: remediation runs
  // sequentially after the parallel reviewers, so it is the only writer now).
  let pushed = false;
  let commitSha: string | undefined;
  try {
    const pushResult = await pushReviewerPatches(
      {
        externalId,
        codeRepo,
        workspacePath,
        githubToken,
        commitMessage: `chore(remediation): apply fixes for ${externalId}`,
      },
      runGit,
    );
    pushed = pushResult.pushed;
    commitSha = pushResult.commitSha;
    if (pushed && commitSha) {
      summaryBody += `\n\n---\n🤖 _Remediation specialist applied fixes — commit \`${commitSha}\`_`;
    }
  } catch (err) {
    console.error('[remediation] pushReviewerPatches failed:', err);
    return {
      ...baseResult,
      status: 'error',
      commentPosted: false,
      pushed: false,
      error: `Failed to push remediation patches: ${sanitizeToken(
        err instanceof Error ? err.message : String(err),
        githubToken,
      )}`,
    };
  }

  // Post the summary as a PR comment.
  try {
    await postPRComment({ prUrl, body: summaryBody, githubToken }, runGh);
  } catch (err) {
    return {
      ...baseResult,
      status: 'error',
      commentPosted: false,
      pushed,
      commitSha,
      error: `Failed to post PR comment: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ...baseResult,
    status: 'done',
    commentPosted: true,
    pushed,
    commitSha,
  };
}
