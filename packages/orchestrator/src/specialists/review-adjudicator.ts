/**
 * Review adjudicator specialist (ADR-037) — synthesizes reviewer verdicts into a
 * unified remediation plan before code-remediator runs. Comment-only; no push.
 */
import { readFile } from 'node:fs/promises';
import type { Product } from '@helm/shared';
import type { AgentResult, SpawnParams } from '../runtime.js';
import type { ReviewerKind } from './reviewer-fanout.js';
import { artifactFileFor } from './code-workspace.js';
import { postPRComment } from './pr-helpers.js';
import { sanitizeToken } from './git-helpers.js';
import type { RunGh } from './git-helpers.js';
import { buildExtraHintsSection } from './extra-hints.js';
import { isEnoentError } from '../lib/fs-errors.js';
import {
  ADJUDICATION_MD_FORMAT,
  parseAdjudicationBody,
  type StoredResolvedProductDecision,
  type ParsedAdjudication,
} from '../review-loop/adjudication.js';

export const REVIEW_ADJUDICATOR_TIMEOUT_MS = 10 * 60 * 1_000;

export type ReviewAdjudicatorResult = {
  status: 'done' | 'error' | 'cancelled';
  costUsd: number;
  durationMs: number;
  commentPosted: boolean;
  parsed?: ParsedAdjudication;
  error?: string;
};

export function buildReviewAdjudicatorParams(
  externalId: string,
  product: Product,
  workspacePath: string,
  prUrl: string,
  findingsByKind: Map<ReviewerKind, string>,
  options: { spec?: string; resolvedProductDecisions?: StoredResolvedProductDecision[] } = {},
): SpawnParams {
  const specialistCfg = product.specialists['review-adjudicator'];
  if (!specialistCfg) {
    throw new Error('review-adjudicator specialist is not configured for this product');
  }

  const defaultBranch = product.code_repos[0]?.default_branch ?? 'main';
  const reviewSections: string[] = [];

  for (const kind of ['code', 'security', 'test'] as const) {
    const body = findingsByKind.get(kind);
    if (body) {
      const label = kind.charAt(0).toUpperCase() + kind.slice(1);
      reviewSections.push('', `## ${label} Review`, '', body);
    }
  }

  const specSection = options.spec ? ['', '## Spec', '', options.spec, ''].join('\n') : '';
  const settledDecisionSection = formatSettledDecisionSection(
    options.resolvedProductDecisions ?? [],
  );
  const hintsSection = buildExtraHintsSection(specialistCfg.extra_hints);
  const artifactPath = artifactFileFor(workspacePath, 'review-adjudicator');

  const prompt = [
    `You are Helm's review adjudicator specialist. Your task is to synthesize conflicting reviewer verdicts for item \`${externalId}\` before remediation runs.`,
    '',
    `The implementation PR is available at: ${prUrl} (for context only — do not merge or close it).`,
    '',
    `The working directory is a shallow clone of the \`helm/impl/${externalId}\` implementation branch.`,
    '',
    `To inspect the diff: \`git fetch --depth 1 origin ${defaultBranch}\` then \`git diff origin/${defaultBranch}...HEAD\``,
    specSection,
    '',
    'The code, security, test, and external review sections below are inputs — they may contradict each other.',
    ...reviewSections,
    '',
    ...(hintsSection ? [hintsSection] : []),
    '**Your task — adjudicate, do not implement fixes:**',
    '- Identify aligned findings that code-remediator can fix mechanically (**AUTO** in the unified plan).',
    '- Identify **product_decision** conflicts (spec ambiguity, contradictory reviewer intent) — list under Conflicts with clear A/B options for a human.',
    '- Identify **doc_conflict** (ADR vs spec vs CLAUDE.md vs reviewer) — resolve using hierarchy ADR > spec > CLAUDE.md, or mark HUMAN_REQUIRED.',
    '- Mark findings as **DEFERRED** when they need design judgment and are not safe to auto-fix.',
    '- Do NOT modify source files. Do NOT commit or push.',
    settledDecisionSection,
    '',
    '## Output format',
    '',
    ADJUDICATION_MD_FORMAT.replace('{externalId}', externalId),
    '',
    `Write the adjudication ONLY to this absolute path:`,
    '',
    `    ${artifactPath}`,
    '',
    'The orchestrator posts it as a PR comment and passes the unified plan to code-remediator when Status is AUTO_REMEDIATE.',
  ].join('\n');

  return {
    specialistId: 'review-adjudicator',
    prompt,
    workdir: workspacePath,
    productSlug: product.product.slug,
    externalId,
    model: specialistCfg.model,
    permissionMode: 'acceptEdits',
    timeoutMs: REVIEW_ADJUDICATOR_TIMEOUT_MS,
  };
}

function formatSettledDecisionSection(decisions: StoredResolvedProductDecision[]): string {
  if (decisions.length === 0) return '';
  return [
    '## Previously Settled Product Decisions',
    '',
    ...decisions.map((decision) =>
      [
        `- **${decision.conflictKind}** · ${decision.conflictTitle}`,
        `  - Fingerprint: ${decision.fingerprint}`,
        `  - Chosen option: ${decision.chosenOption}`,
        `  - Recorded at: ${decision.recordedAt} by ${decision.source.authorLogin}`,
        decision.scope.paths.length > 0 ? `  - Paths: ${decision.scope.paths.join(', ')}` : '',
        decision.scope.markers.length > 0
          ? `  - Scope markers: ${decision.scope.markers.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '',
    'If a current conflict has the same fingerprint, treat the human choice as settled and include any remaining mechanical work in the unified remediation plan instead of asking for the same decision again.',
  ].join('\n');
}

export async function handleReviewAdjudicatorResult(
  externalId: string,
  agentResult: AgentResult,
  workspacePath: string,
  prUrl: string,
  githubToken: string,
  runGh?: RunGh,
): Promise<ReviewAdjudicatorResult> {
  const baseResult = {
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

  let body: string;
  try {
    body = await readFile(artifactFileFor(workspacePath, 'review-adjudicator'), 'utf-8');
  } catch (err) {
    if (!isEnoentError(err)) {
      throw err;
    }
    body = [
      `# Review Adjudication: ${externalId}`,
      '',
      '_No adjudication summary was produced._',
      '',
      '## Status',
      'HUMAN_REQUIRED',
    ].join('\n');
  }

  const parsed = parseAdjudicationBody(body);

  try {
    await postPRComment({ prUrl, body, githubToken }, runGh);
  } catch (err) {
    return {
      ...baseResult,
      status: 'error',
      commentPosted: false,
      parsed,
      error: `Failed to post adjudication comment: ${sanitizeToken(
        err instanceof Error ? err.message : String(err),
        githubToken,
      )}`,
    };
  }

  return {
    ...baseResult,
    status: 'done',
    commentPosted: true,
    parsed,
  };
}
