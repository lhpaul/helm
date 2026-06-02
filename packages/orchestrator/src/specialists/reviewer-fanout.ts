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
import type { CodeRepo, Product } from '@helm/shared';
import type { AgentResult, IAgentRuntime, SpawnParams } from '../runtime.js';
import {
  provisionReviewerWorkspace,
  pushReviewerPatches,
  artifactFileFor,
  artifactsDirFor,
} from './code-workspace.js';
import { fetchSpecForPlan, type FetchFn } from './fetch-product-context.js';
import { postPRComment } from './pr-helpers.js';
import { sanitizeToken } from './git-helpers.js';
import type { RunGit, RunGh } from './git-helpers.js';
import { buildExtraHintsSection } from './extra-hints.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewerKind = 'code' | 'security' | 'test';

export const REVIEWER_KINDS: readonly ReviewerKind[] = ['code', 'security', 'test'] as const;

/** 10 minutes per reviewer — covers reading codebase + generating structured review. */
export const REVIEWER_TIMEOUT_MS = 10 * 60 * 1_000;

/** Per-severity finding counts parsed from a review.md body. */
export type Findings = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type ReviewerResult = {
  kind: ReviewerKind;
  status: 'done' | 'error' | 'cancelled';
  costUsd: number;
  durationMs: number;
  commentPosted: boolean;
  /** Per-severity finding counts. Present only when a comment was posted. */
  findings?: Findings;
  /** Full review.md body posted as the comment. Present only when a comment was posted. */
  commentBody?: string;
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
  'code-reviewer' | 'security-reviewer' | 'test-reviewer'
> = {
  code: 'code-reviewer',
  security: 'security-reviewer',
  test: 'test-reviewer',
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

Recognised finding categories include a structured **Contract drift §4** tag,
emitted by the code reviewer when a schema-touching diff diverges from the
canonical \`CLAUDE.md\` §4 contract. Use the literal prefix
\`**HIGH** · Contract drift §4 · <table>.<column or convention>\` so the
divergence is greppable downstream. The severity tag is parsed identically to
any other finding.

## Status
APPROVED | CHANGES_REQUESTED

(Use APPROVED only if there are no findings of severity MEDIUM or above.)`.trim();

// ── parseFindings ─────────────────────────────────────────────────────────────

const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

/**
 * Counts severity-tagged findings in a review.md body.
 *
 * A finding is any occurrence of a `**SEVERITY** ·` tag (the dialect defined by
 * REVIEW_MD_FORMAT). Matching is anchored only on the tag, so the parser is
 * robust to arbitrary surrounding markdown — it does not assume bullet lists,
 * heading structure, or one finding per line beyond the tag itself.
 *
 * The separator after the severity tag is the middle dot (`·`); intervening
 * whitespace is tolerated so minor agent formatting drift does not drop counts.
 */
export function parseFindings(reviewBody: string): Findings {
  const findings: Findings = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const level of SEVERITY_LEVELS) {
    const re = new RegExp(`\\*\\*${level}\\*\\*\\s*·`, 'g');
    const matches = reviewBody.match(re);
    findings[level.toLowerCase() as keyof Findings] = matches ? matches.length : 0;
  }
  return findings;
}

/**
 * Remediation gate: returns true iff ANY reviewer (code, security, or test)
 * surfaced at least one CRITICAL or HIGH finding.
 *
 * The code-reviewer still gets the first chance to self-apply its mechanical
 * fixes in-flow (ADR-018). But when it doesn't (it writes only a summary with no
 * source edits), its CRITICAL/HIGH findings used to pass through review unfixed
 * because they never reached the remediator. As of ADR-025 the remediator is the
 * unified safety net behind all three reviewers, so code-reviewer findings gate
 * remediation too. MEDIUM/LOW/INFO are commented but do not gate.
 */
export function shouldRemediate(results: ReviewerResult[]): boolean {
  return results.some(
    (r) => r.findings !== undefined && (r.findings.critical > 0 || r.findings.high > 0),
  );
}

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

  const hintsSection = buildExtraHintsSection(specialistCfg.extra_hints);

  // Reviewers write their summary to a SIBLING artifacts directory, OUTSIDE the
  // git clone (ADR-025), so it can never be staged onto the impl branch.
  const artifactPath = artifactFileFor(workspacePath, specialistId);

  const outputInstruction = [
    '',
    '## Output',
    '',
    `Write your review to this exact absolute path using the following format exactly:`,
    '',
    `    ${artifactPath}`,
    '',
    REVIEW_MD_FORMAT.replace('{Kind}', kindLabel).replace('{externalId}', externalId),
    '',
    `Write the review ONLY to that absolute path — it is outside the working directory on purpose. Do NOT create a \`review.md\` inside the working directory, and do not commit or push. The orchestrator reads that file and posts it as a PR comment.`,
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
        '### Contract validation (schema-touching diffs only)',
        '',
        "If the diff touches schema definitions, migrations, or entity type declarations, **validate the diff against the canonical contract** in the target repo's `CLAUDE.md`.",
        '',
        '1. Open `CLAUDE.md` from the working directory.',
        '2. Look for a "Data model" / "§4" section (any heading matching `## 4.`, `### 4.`, `## Data model`, `## Schema`, or `## Domain model`). If none is present, skip this step and proceed with the rest of the review.',
        "3. For each table, column, enum value, JSONB key, RLS clause, and convention rule referenced in the diff, compare against the canonical section. **That product's own §4 is the only baseline — the items below are the categories to check, not values to expect.** Validate: column names (canonical spelling and case — e.g. snake_case if the contract uses it), types (match the canonical SQL type exactly — integer width, numeric precision/scale, UUID version, timestamp timezone, monetary representation), enum values, JSONB shapes, RLS enable/force, default values.",
        '4. For every divergence, emit a finding using this exact format:',
        '',
        '   ```',
        '   **HIGH** · Contract drift §4 · <table>.<column or convention>',
        '   Canonical: <what §4 says>',
        '   Diff: <what the implementer wrote>',
        '   File: <path>:<line>',
        '   Fix: <rename | retype | drop | reshape — one concrete action>',
        '   ```',
        '',
        '5. If the diff is consistent with the canonical contract, do not emit any contract drift findings — silence is pass.',
        '6. **Findings-only — never auto-apply.** A `Contract drift §4` finding MUST be surfaced for review only. Do NOT edit schema, migration, or entity-type files to apply the fix yourself, no matter how mechanical the rename looks. These divergences route through the HIGH-severity remediation path on purpose; auto-fixing one short-circuits that path, and editing an already-committed migration file is itself a contract violation (migrations are immutable post-apply — the fix is a new forward migration, not an edit). Leave contract drift to the remediator.',
        '',
        '**Scope gate:** Only invoke contract validation when the diff includes at least one file matching schema/migration/entity-type globs. If the diff is purely application code with no schema impact, skip contract validation entirely (no Pass/Fail line needed).',
        '',
        '**Applying mechanical fixes (code reviewer only):**',
        'If you identify mechanical, low-risk fixes (typos, formatting, dead-code removal, obvious simplifications without logic changes), apply them directly to the files in the working directory. The orchestrator will commit and push. For non-mechanical or invasive changes, surface them as findings only — do NOT modify files. **This mechanical-fix permission never extends to schema, migration, or entity-type files: contract drift (see above) is findings-only regardless of how simple the change appears.**',
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
        '**Do not modify any files in the working directory.** Surface all findings in your review only (written to the artifact path shown below). The orchestrator does not push changes from security or test reviewers.',
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
        '**Do not modify any files in the working directory.** Surface all findings in your review only (written to the artifact path shown below). The orchestrator does not push changes from security or test reviewers.',
      ].join('\n');
      break;
  }

  const prompt = [
    commonHeader,
    specSection,
    ...(hintsSection ? [hintsSection] : []),
    kindSpecificInstructions,
    outputInstruction,
  ].join('\n');

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

  // Read the review summary from the sibling artifacts directory (ADR-025) —
  // fall back to a placeholder if the agent didn't write one.
  let reviewContent: string;
  try {
    reviewContent = await readFile(artifactFileFor(workspacePath, `${kind}-reviewer`), 'utf-8');
  } catch {
    reviewContent = [
      `# ${kind.charAt(0).toUpperCase() + kind.slice(1)} Review: ${externalId}`,
      '',
      '_No review summary was produced by the reviewer agent._',
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
      // Defense-in-depth: sanitize the token even though pushReviewerPatches
      // already does so — a second pass costs nothing and prevents regressions
      // if the error originates outside pushReviewerPatches.
      pushError = sanitizeToken(err instanceof Error ? err.message : String(err), githubToken);
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

  // Parse findings from the posted body so the remediation gate can inspect them.
  const findings = parseFindings(reviewContent);

  // If the push failed (code reviewer), report error — comment was still posted.
  if (pushError !== undefined) {
    return {
      ...baseResult,
      status: 'error',
      commentPosted: true,
      findings,
      commentBody: reviewContent,
      error: `Comment posted but push failed: ${pushError}`,
    };
  }

  return {
    ...baseResult,
    status: 'done',
    commentPosted: true,
    findings,
    commentBody: reviewContent,
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
      [...workspacePaths.values()].flatMap((p) => [
        rm(p, { recursive: true, force: true }),
        rm(artifactsDirFor(p), { recursive: true, force: true }),
      ]),
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
      [...workspacePaths.values()].flatMap((p) => [
        rm(p, { recursive: true, force: true }),
        rm(artifactsDirFor(p), { recursive: true, force: true }),
      ]),
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
