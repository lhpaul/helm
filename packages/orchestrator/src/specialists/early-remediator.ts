/**
 * Early-stage remediation helper — the spec/plan analogue of the code-review
 * remediation specialist (ADR-024).
 *
 * `spec-draft` and `plan-draft` are one-shot today: the spec/plan writer opens a
 * knowledge-repo PR and the operator's only lever is "regenerate from scratch".
 * The early remediator closes that gap by iterating the *existing* artifact PR
 * in-place from structured operator feedback, mirroring the code-review
 * remediation pattern at the early stages.
 *
 * Flow (`runEarlyRemediation`):
 *   1. Shallow-clone the existing artifact branch (`helm/spec/<id>` or
 *      `helm/plan/<id>`) of the knowledge repo into an isolated temp dir.
 *   2. Read the current artifact (`specs/<id>.md` / `plans/<id>.md`).
 *   3. Build the remediator prompt (current artifact + operator feedback + hints)
 *      and spawn the runtime; the agent edits the file in-place.
 *   4. Commit + push the edit to the *same* branch (single-pusher: the remediator
 *      is operator-triggered and sequential, so it is the only writer at its
 *      moment in time — fast-forward push, never --force).
 *   5. Return an AgentResult-derived summary carrying the *same* prUrl — the
 *      remediator never opens a new PR.
 *
 * The agent never commits or pushes and never receives GITHUB_TOKEN — the
 * orchestrator owns git/gh, mirroring the writer/publisher and reviewer designs.
 *
 * PR discovery is the dispatcher's job (via `findArtifactPRUrl`): the dispatcher
 * passes the resolved `prUrl` here and the helper threads it back unchanged.
 */
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Product } from '@helm/shared';
import { specBranchName, planBranchName } from '@helm/shared';
import type { AgentResult, IAgentRuntime, SpawnParams } from '../runtime.js';
import type { ProductContext } from './fetch-product-context.js';
import { parseGitHubRepoUrl } from './fetch-product-context.js';
import { buildAuthenticatedUrl, sanitizeToken, defaultRunGit, type RunGit } from './git-helpers.js';
import { buildExtraHintsSection } from './extra-hints.js';

// ── Kinds ──────────────────────────────────────────────────────────────────────

/** Early-stage artifact kinds that have a remediation flow (ADR-024). */
export type EarlyRemediatorKind = 'spec' | 'plan';

type KindConfig = {
  /** Specialist ID in product.specialists (also the SpawnParams.specialistId). */
  readonly specialistId: 'spec-remediator' | 'plan-remediator';
  /** Branch name fn (knowledge repo). */
  readonly branchNameFn: (id: string) => string;
  /** Sub-directory + file naming for the artifact. */
  readonly destSubDir: 'specs' | 'plans';
  /** Human label used in prompt headings, e.g. "Spec". */
  readonly label: 'Spec' | 'Plan';
  /** Lowercase noun used in prose, e.g. "spec". */
  readonly noun: 'spec' | 'plan';
  readonly errorTag: string;
};

const KIND_CONFIG: Record<EarlyRemediatorKind, KindConfig> = {
  spec: {
    specialistId: 'spec-remediator',
    branchNameFn: specBranchName,
    destSubDir: 'specs',
    label: 'Spec',
    noun: 'spec',
    errorTag: '[spec-remediator]',
  },
  plan: {
    specialistId: 'plan-remediator',
    branchNameFn: planBranchName,
    destSubDir: 'plans',
    label: 'Plan',
    noun: 'plan',
    errorTag: '[plan-remediator]',
  },
};

// ── Timeout ──────────────────────────────────────────────────────────────────

/**
 * 15 minutes — same budget as the code-review remediator. Editing an existing
 * artifact from targeted feedback is bounded work: more than a read-only
 * reviewer, less than a from-scratch writer, which is fine to share.
 */
export const EARLY_REMEDIATION_TIMEOUT_MS = 15 * 60 * 1_000;

// ── EXTERNAL_ID guard ──────────────────────────────────────────────────────────

// Mirrors EXTERNAL_ID_SAFE in code-workspace.ts / spec-publisher.ts — the
// (?!\.) lookahead rejects dot-segment values in addition to the char class.
const EXTERNAL_ID_SAFE = /^(?!\.)[A-Za-z0-9._-]+$/;

// ── Result type ────────────────────────────────────────────────────────────────

export type EarlyRemediationResult = {
  status: 'done' | 'error' | 'cancelled';
  costUsd: number;
  durationMs: number;
  /** True when the agent's edits were committed and pushed. */
  pushed: boolean;
  commitSha?: string;
  /** The PR URL the remediator iterated — unchanged (no new PR opened). */
  prUrl: string;
  error?: string;
};

// ── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Builds the "## Product Context" header from the product config alone (no
 * network fetch required). When a fetched `ProductContext` is supplied, the
 * README and agent instructions are appended.
 */
function buildContextSection(product: Product, context?: ProductContext): string {
  const lines: string[] = [
    '## Product Context',
    '',
    `**Product:** ${product.product.name} (slug: \`${product.product.slug}\`)`,
    `**Code repo:** ${product.code_repos[0]?.url ?? 'N/A'} (branch: \`${product.code_repos[0]?.default_branch ?? 'main'}\`)`,
    `**Workflow stages:** ${product.workflow.stages_enabled.join(' → ')}`,
    '',
  ];
  if (context?.readme) {
    lines.push('### README', '', context.readme, '');
  }
  if (context?.agentMd) {
    lines.push('### Agent Instructions', '', context.agentMd, '');
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Builds the remediator prompt. The agent edits the artifact in-place using the
 * operator feedback; it preserves unaffected content and does not regenerate the
 * document from scratch or open a new PR.
 */
export function buildEarlyRemediatorPrompt(
  kind: EarlyRemediatorKind,
  externalId: string,
  product: Product,
  currentArtifact: string,
  feedback: string,
  context?: ProductContext,
): string {
  const cfg = KIND_CONFIG[kind];
  const hintsSection = buildExtraHintsSection(product.specialists[cfg.specialistId].extra_hints);
  const artifactRelPath = `${cfg.destSubDir}/${externalId}.md`;

  return `You are the ${cfg.noun} remediator for the product "${product.product.name}".

${buildContextSection(product, context)}## Task

Item: \`${externalId}\`
Apply the operator's feedback to the existing ${cfg.noun} in-place.

## Current ${cfg.label}

The current ${cfg.noun} lives at \`${artifactRelPath}\` in your working directory:

${currentArtifact}

## Feedback

${feedback}

${hintsSection}**Your task — apply the feedback above:**
- Edit the file \`${artifactRelPath}\` in your working directory to incorporate the feedback.
- Preserve content the feedback does not touch — do NOT regenerate the ${cfg.noun} from scratch.
- Keep the existing structure and headings unless the feedback asks you to change them.
- Do NOT commit, push, or open a new PR — the orchestrator commits your edits and pushes them to the existing PR branch.

Write the updated ${cfg.noun} directly to \`${artifactRelPath}\`. Do not ask for confirmation before writing.

Product: ${product.product.slug}`;
}

/**
 * Builds SpawnParams for an early-stage remediator.
 */
export function buildEarlyRemediatorParams(
  kind: EarlyRemediatorKind,
  externalId: string,
  product: Product,
  workspacePath: string,
  currentArtifact: string,
  feedback: string,
  context?: ProductContext,
): SpawnParams {
  const cfg = KIND_CONFIG[kind];
  return {
    specialistId: cfg.specialistId,
    prompt: buildEarlyRemediatorPrompt(
      kind,
      externalId,
      product,
      currentArtifact,
      feedback,
      context,
    ),
    workdir: workspacePath,
    productSlug: product.product.slug,
    externalId,
    model: product.specialists[cfg.specialistId].model,
    permissionMode: 'acceptEdits',
    timeoutMs: EARLY_REMEDIATION_TIMEOUT_MS,
  };
}

// ── Workspace provisioning ─────────────────────────────────────────────────────

type ProvisionResult = { workspacePath: string; owner: string; repo: string; branchName: string };

/**
 * Shallow-clones the **existing** artifact branch (`helm/spec/<id>` or
 * `helm/plan/<id>`) of the knowledge repo into an isolated temp dir, then scrubs
 * the token from `.git/config` (the agent runs in this workspace).
 *
 * Mirrors `provisionReviewerWorkspace` (code-workspace.ts) for the knowledge repo.
 */
async function provisionArtifactWorkspace(
  kind: EarlyRemediatorKind,
  externalId: string,
  product: Product,
  githubToken: string,
  runGit: RunGit,
): Promise<ProvisionResult> {
  const cfg = KIND_CONFIG[kind];

  if (!EXTERNAL_ID_SAFE.test(externalId)) {
    throw new Error(`${cfg.errorTag} Invalid externalId: "${externalId}"`);
  }

  const knowledgeRepo = product.knowledge_repo;
  if (knowledgeRepo.url.startsWith('git@') || knowledgeRepo.url.startsWith('ssh://')) {
    throw new Error(
      `${cfg.errorTag} SSH knowledge repo URLs are not supported for token-based auth. ` +
        `Use an HTTPS URL instead.`,
    );
  }

  const parsed = parseGitHubRepoUrl(knowledgeRepo.url);
  if (!parsed) {
    throw new Error(`${cfg.errorTag} Cannot parse knowledge repo URL: ${knowledgeRepo.url}`);
  }
  const { owner, repo } = parsed;

  const authenticatedUrl = buildAuthenticatedUrl(owner, repo, githubToken);
  const branchName = cfg.branchNameFn(externalId);
  const workspacePath = join(tmpdir(), `helm-${cfg.noun}-remediate-${externalId}-${randomUUID()}`);
  await mkdir(workspacePath, { recursive: true });

  // ── Clone the existing artifact branch ─────────────────────────────────────
  // If the branch does not exist on the remote, git fails with a clear
  // "Remote branch X not found" message (sanitized below).
  try {
    await runGit(
      ['clone', '--depth', '1', '--branch', branchName, authenticatedUrl, workspacePath],
      { cwd: tmpdir() },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `${cfg.errorTag} Failed to clone ${cfg.noun} branch '${branchName}' (${knowledgeRepo.url}): ${sanitizeToken(raw, githubToken)}`,
    );
  }

  // ── Scrub token from .git/config ───────────────────────────────────────────
  const canonicalUrl = `https://github.com/${owner}/${repo}`;
  try {
    await runGit(['remote', 'set-url', 'origin', canonicalUrl], { cwd: workspacePath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `${cfg.errorTag} Failed to strip token from git config: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  return { workspacePath, owner, repo, branchName };
}

// ── Push helper ────────────────────────────────────────────────────────────────

type PushResult = { pushed: boolean; commitSha?: string };

/**
 * Stages the agent's edits, commits as helm-bot, and fast-forward pushes to the
 * existing artifact branch. Returns `{ pushed: false }` when the agent made no
 * change. NOT a --force push: the remediator appends one commit on top of the
 * branch tip it cloned (single-pusher invariant).
 */
async function pushArtifactEdits(
  kind: EarlyRemediatorKind,
  externalId: string,
  provision: ProvisionResult,
  githubToken: string,
  runGit: RunGit,
): Promise<PushResult> {
  const cfg = KIND_CONFIG[kind];
  const { workspacePath, owner, repo, branchName } = provision;

  // Scope every git operation to the single artifact file. The temp clone is not
  // scrubbed of untracked files after the agent runs, so a blanket `status`/`add`
  // could sweep stray files into the commit pushed onto the live artifact branch.
  const artifactRelPath = `${cfg.destSubDir}/${externalId}.md`;

  const gitEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: 'helm-bot',
    GIT_AUTHOR_EMAIL: 'helm-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'helm-bot',
    GIT_COMMITTER_EMAIL: 'helm-bot@users.noreply.github.com',
  };

  // ── Check for changes (artifact file only) ─────────────────────────────────
  let statusOut: string;
  try {
    const result = await runGit(['status', '--porcelain', '--', artifactRelPath], {
      cwd: workspacePath,
    });
    statusOut = result.stdout.trim();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${cfg.errorTag} Failed to check git status: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  if (!statusOut) {
    return { pushed: false };
  }

  // ── Stage + commit (artifact file only) ────────────────────────────────────
  try {
    await runGit(['add', '--', artifactRelPath], { cwd: workspacePath });
    await runGit(['commit', '-m', `docs(${cfg.noun}): remediate ${externalId} from feedback`], {
      cwd: workspacePath,
      env: gitEnv,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${cfg.errorTag} Failed to commit ${cfg.noun} edits: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  // ── Capture commit SHA ─────────────────────────────────────────────────────
  let commitSha: string;
  try {
    const result = await runGit(['rev-parse', 'HEAD'], { cwd: workspacePath });
    commitSha = result.stdout.trim();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${cfg.errorTag} Failed to read commit SHA: ${sanitizeToken(raw, githubToken)}`,
    );
  }

  // ── Push (fast-forward, NO --force) ────────────────────────────────────────
  // origin was scrubbed of the token, so push directly to the authenticated URL.
  const pushUrl = buildAuthenticatedUrl(owner, repo, githubToken);
  try {
    await runGit(['push', pushUrl, `${branchName}:${branchName}`], { cwd: workspacePath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${cfg.errorTag} Failed to push ${cfg.noun} edits for '${branchName}': ${sanitizeToken(raw, githubToken)}`,
    );
  }

  return { pushed: true, commitSha };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export type RunEarlyRemediationParams = {
  kind: EarlyRemediatorKind;
  externalId: string;
  product: Product;
  /** The existing artifact PR URL (resolved by the dispatcher). Threaded back unchanged. */
  prUrl: string;
  /** Operator feedback to apply. Must be non-empty (validated by the dispatcher/API). */
  feedback: string;
  githubToken: string;
  runtime: IAgentRuntime;
  /** Optional fetched product context (README + agent instructions). */
  context?: ProductContext;
  runGit?: RunGit;
};

/**
 * Runs the end-to-end early-stage remediation: provision → spawn agent →
 * push edits. Never throws — all failures are captured in the result.
 */
export async function runEarlyRemediation(
  params: RunEarlyRemediationParams,
): Promise<EarlyRemediationResult> {
  const { kind, externalId, product, prUrl, feedback, githubToken, runtime, context } = params;
  const runGit = params.runGit ?? defaultRunGit;
  const cfg = KIND_CONFIG[kind];

  const base = { costUsd: 0, durationMs: 0, prUrl };

  // ── Provision workspace ─────────────────────────────────────────────────────
  let provision: ProvisionResult;
  try {
    provision = await provisionArtifactWorkspace(kind, externalId, product, githubToken, runGit);
  } catch (err) {
    return {
      ...base,
      status: 'error',
      pushed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    // ── Read the current artifact ─────────────────────────────────────────────
    const artifactRelPath = `${cfg.destSubDir}/${externalId}.md`;
    let currentArtifact: string;
    try {
      currentArtifact = await readFile(join(provision.workspacePath, artifactRelPath), 'utf-8');
    } catch {
      return {
        ...base,
        status: 'error',
        pushed: false,
        error: `${cfg.errorTag} ${cfg.noun} file not found at ${artifactRelPath} on branch ${provision.branchName}`,
      };
    }

    // ── Spawn the agent ───────────────────────────────────────────────────────
    const spawnParams = buildEarlyRemediatorParams(
      kind,
      externalId,
      product,
      provision.workspacePath,
      currentArtifact,
      feedback,
      context,
    );
    const session = await runtime.spawn(spawnParams);
    const agentResult: AgentResult = await session.wait();

    if (agentResult.status !== 'done') {
      if (agentResult.finalOutput) {
        console.error(`${cfg.errorTag} Agent failure details`, {
          externalId,
          status: agentResult.status,
        });
      }
      return {
        status: agentResult.status,
        costUsd: agentResult.totalCostUsd,
        durationMs: agentResult.durationMs,
        pushed: false,
        prUrl,
        error: `Agent finished with status '${agentResult.status}'`,
      };
    }

    // ── Push the edits to the existing branch ──────────────────────────────────
    let push: PushResult;
    try {
      push = await pushArtifactEdits(kind, externalId, provision, githubToken, runGit);
    } catch (err) {
      return {
        status: 'error',
        costUsd: agentResult.totalCostUsd,
        durationMs: agentResult.durationMs,
        pushed: false,
        prUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      status: 'done',
      costUsd: agentResult.totalCostUsd,
      durationMs: agentResult.durationMs,
      pushed: push.pushed,
      commitSha: push.commitSha,
      prUrl,
    };
  } finally {
    await rm(provision.workspacePath, { recursive: true, force: true }).catch(() => {});
  }
}
