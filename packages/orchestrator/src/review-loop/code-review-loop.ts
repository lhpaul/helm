import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeRepo, Product } from '@helm/shared';
import type { IAgentRuntime } from '../runtime.js';
import type { ItemTransitionFn } from '../specialists/spec-writer.js';
import {
  fanoutReviewers,
  shouldRemediate,
  type ReviewerFanoutResult,
  type ReviewerKind,
  type ReviewerResult,
  type ReviewCommentTransform,
  type ReviewCommentTransformInput,
  type ReviewCommentTransformResult,
} from '../specialists/reviewer-fanout.js';
import {
  buildRemediationParams,
  handleRemediationResult,
  type RemediationResult,
} from '../specialists/remediation.js';
import {
  buildReviewAdjudicatorParams,
  handleReviewAdjudicatorResult,
} from '../specialists/review-adjudicator.js';
import { fetchSpecForPlan, type FetchFn } from '../specialists/fetch-product-context.js';
import {
  provisionReviewerWorkspace,
  artifactsDirFor,
  EXTERNAL_ID_SAFE,
} from '../specialists/code-workspace.js';
import type { RunGit, RunGh } from '../specialists/git-helpers.js';
import { runExternalReviewIfConfigured, parsePullRequestRef } from '../external-review/run.js';
import type { RunExternalReviewDeps } from '../external-review/run.js';
import type {
  ExternalReviewContext,
  ExternalReviewResult,
  NormalizedFinding,
} from '../external-review/types.js';
import { defaultSleep } from '../external-review/haystack/triage-poll.js';
import {
  fetchHaystackSkipEvidence,
  type HaystackSkipEvidence,
} from '../external-review/haystack/skip-evidence.js';
import { postPRComment } from '../specialists/pr-helpers.js';
import { resolveReviewLoopConfig, type ReviewLoopConfig } from './config.js';
import { formatReviewLoopEscalationComment } from './escalation-comment.js';
import { evaluateExternalReviewStopRule } from './external-stop-rule.js';
import {
  fetchFalsePositivesCatalog,
  matchesFalsePositiveFinding,
  type FalsePositiveEntry,
} from './false-positives.js';
import { upsertReviewLoopSummaryComment } from './summary.js';
import {
  countBlockingFindings,
  evaluateStopRule,
  nextNoProgressStreak,
  type StopRuleEscalationReason,
} from './stop-rule.js';
import {
  collectGateFindingFingerprints,
  createStickyLane,
  observeStickyLane,
  recordStickyImprovement,
} from './finding-fingerprint.js';
import { isEnoentError } from '../lib/fs-errors.js';
import { type StoredResolvedProductDecision } from './adjudication.js';
import type { WorkflowStage } from '@helm/workflow';

export type CodeReviewLoopResult = {
  status: 'done' | 'error' | 'deferred';
  prUrl: string;
  costUsd: number;
  durationMs: number;
  cyclesCompleted: number;
  newStage?: 'code-review' | 'remediation';
  deferredExternalReview?: DeferredExternalReviewIntent;
  error?: string;
  escalated?: boolean;
  escalationReason?: StopRuleEscalationReason;
};

export type DeferredExternalReviewIntent = {
  productSlug: string;
  externalId: string;
  specialistId: 'reviewer-fanout' | 'spec-draft-reviewer' | 'plan-draft-reviewer';
  provider: string;
  reason: 'analysis_pending';
  providerReason?: string;
  prNumber: number;
  targetRevision?: string;
  maxDeferSec: number;
};

export type RunCodeReviewLoopParams = {
  externalId: string;
  product: Product;
  prUrl: string;
  codeRepo: CodeRepo;
  branchName?: string;
  kind?: 'spec' | 'plan';
  githubToken: string;
  runtime: IAgentRuntime;
  transition: ItemTransitionFn;
  runGit?: RunGit;
  runGh?: RunGh;
  externalReviewDeps?: RunExternalReviewDeps;
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: FetchFn;
  resolvedProductDecisions?: StoredResolvedProductDecision[];
  /**
   * Optional per-pass loader for the settled-decision ledger. When provided,
   * each adjudication/remediation cycle reloads decisions from durable storage
   * so a human choice recorded while the job is still running is visible.
   */
  loadResolvedProductDecisions?: () => Promise<StoredResolvedProductDecision[]>;
  targetRevision?: string;
  onExternalReviewDeferred?: (intent: DeferredExternalReviewIntent) => Promise<void> | void;
  mode?: 'code' | 'early-artifact';
};

function escalationMessage(
  reason: StopRuleEscalationReason,
  cyclesCompleted: number,
  noProgressCycles?: number,
): string {
  if (reason === 'max_cycles') {
    return `Review loop escalated: reached max_cycles (${cyclesCompleted}) with CRITICAL/HIGH findings still open`;
  }
  if (reason === 'no_progress') {
    const threshold = noProgressCycles === undefined ? cyclesCompleted : noProgressCycles;
    return `Review loop escalated: no progress on blocking findings for ${threshold} consecutive remediation cycle(s) (${cyclesCompleted} cycle(s) completed)`;
  }
  if (reason === 'adjudication_conflict') {
    return `Review loop escalated: review-adjudicator requires human product or documentation decisions (${cyclesCompleted} cycle(s) completed)`;
  }
  if (reason === 'external_escalate') {
    return `Review loop escalated: external review returned escalate (${cyclesCompleted} cycle(s) completed)`;
  }
  if (reason === 'external_skip_evidence') {
    return `Review loop escalated: external review skipped with evidence findings may exist (${cyclesCompleted} cycle(s) completed)`;
  }
  return `Review loop escalated: external review skipped repeatedly (${cyclesCompleted} cycle(s) completed)`;
}

function buildExternalReviewContext(params: RunCodeReviewLoopParams): ExternalReviewContext | null {
  const prRef = parsePullRequestRef(params.prUrl);
  if (!prRef) return null;
  return {
    owner: prRef.owner,
    repo: prRef.repo,
    prNumber: prRef.prNumber,
    prUrl: params.prUrl,
    defaultBranch: params.codeRepo.default_branch,
  };
}

function externalRetryDelayMs(product: Product): number {
  const pollSec = product.review?.external?.haystack?.poll_interval_sec ?? 15;
  return pollSec * 1000;
}

function externalMaxDeferSec(product: Product): number {
  return product.review?.external?.max_defer_sec ?? 30 * 60;
}

async function postEscalationCommentBestEffort(
  params: RunCodeReviewLoopParams,
  input: {
    reason: StopRuleEscalationReason;
    message: string;
    cyclesCompleted: number;
    evidence?: HaystackSkipEvidence;
    externalReason?: string;
  },
): Promise<void> {
  const body = formatReviewLoopEscalationComment(input);
  try {
    await postPRComment(
      { prUrl: params.prUrl, body, githubToken: params.githubToken },
      params.runGh,
    );
  } catch {
    // Best-effort — escalation still returns error to the operator.
  }
}

async function postReviewLoopSummaryBestEffort(
  params: RunCodeReviewLoopParams,
  input: {
    cyclesCompleted: number;
    advisories: NormalizedFinding[];
    stage: WorkflowStage;
    externalProvider?: string;
  },
): Promise<void> {
  if (input.advisories.length === 0) return;

  try {
    const catalog = await fetchFalsePositivesCatalog(
      params.product,
      params.githubToken,
      params.fetchFn,
    );
    await upsertReviewLoopSummaryComment({
      prUrl: params.prUrl,
      githubToken: params.githubToken,
      cyclesCompleted: input.cyclesCompleted,
      externalProvider: input.externalProvider,
      advisories: input.advisories,
      catalog,
      stage: input.stage,
      runGh: params.runGh,
    });
  } catch {
    // Best-effort — clean loop exit is still valid without the summary comment.
  }
}

function stageForLoopParams(params: RunCodeReviewLoopParams): WorkflowStage {
  if (params.mode !== 'early-artifact') return 'code-review';
  return params.kind === 'spec' ? 'spec-draft' : 'plan-draft';
}

function findFalsePositiveMatch(
  finding: NormalizedFinding,
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
): FalsePositiveEntry | undefined {
  return catalog.find(
    (entry) =>
      (entry.appliesTo === undefined || entry.appliesTo.includes(stage)) &&
      matchesFalsePositiveFinding(entry, finding),
  );
}

async function suppressFalsePositiveExternalFindings(
  params: RunCodeReviewLoopParams,
  findings: NormalizedFinding[],
): Promise<{ blockers: NormalizedFinding[]; suppressed: NormalizedFinding[] }> {
  if (findings.length === 0) return { blockers: [], suppressed: [] };

  const stage = stageForLoopParams(params);
  const catalog = await fetchFalsePositivesCatalog(
    params.product,
    params.githubToken,
    params.fetchFn,
  );
  const blockers: NormalizedFinding[] = [];
  const suppressed: NormalizedFinding[] = [];

  for (const finding of findings) {
    if (findFalsePositiveMatch(finding, catalog, stage)) {
      suppressed.push({ ...finding, blocking: false });
    } else {
      blockers.push(finding);
    }
  }

  return { blockers, suppressed };
}

function suppressFalsePositiveReviewerComment(
  input: ReviewCommentTransformInput,
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
): ReviewCommentTransformResult {
  const findings = { ...input.findings };
  let suppressedCount = 0;
  const reviewContentWithSuppressedFindings = input.reviewContent.replace(
    /\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*\s*·\s*([^\n]+)/g,
    (line, rawSeverity: string, summary: string) => {
      if (summary.startsWith('Catalogued false positive:')) return line;

      const severity = rawSeverity.toLowerCase() as NormalizedFinding['severity'];
      const finding: NormalizedFinding = {
        id: `${input.kind}:${summary}`,
        severity,
        blocking: true,
        summary,
      };

      if (!findFalsePositiveMatch(finding, catalog, stage)) return line;
      suppressedCount += 1;
      if (findings[severity] > 0) findings[severity] -= 1;
      findings.info += 1;
      return `**INFO** · Catalogued false positive: ${summary}`;
    },
  );

  // No catalog match: preserve the reviewer-authored status (do not flip
  // CHANGES_REQUESTED → APPROVED just because medium+ counts are already zero).
  if (suppressedCount === 0) {
    return { reviewContent: input.reviewContent, findings: input.findings };
  }

  const status =
    findings.critical + findings.high + findings.medium > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
  const reviewContent = rewriteReviewStatus(reviewContentWithSuppressedFindings, status);

  return { reviewContent, findings };
}

function rewriteReviewStatus(reviewContent: string, status: 'APPROVED' | 'CHANGES_REQUESTED') {
  const statusSection = /(^##\s+Status\s*\n)\s*(?:APPROVED|CHANGES_REQUESTED)\b/im;
  if (statusSection.test(reviewContent)) {
    return reviewContent.replace(statusSection, `$1${status}`);
  }
  return `${reviewContent.trimEnd()}\n\n## Status\n${status}`;
}

async function buildFalsePositiveReviewerCommentTransform(
  params: RunCodeReviewLoopParams,
): Promise<ReviewCommentTransform | undefined> {
  if (params.mode !== 'early-artifact') return undefined;

  const stage = stageForLoopParams(params);
  const catalog = await fetchFalsePositivesCatalog(
    params.product,
    params.githubToken,
    params.fetchFn,
  );
  if (catalog.length === 0) return undefined;

  return (input) => suppressFalsePositiveReviewerComment(input, catalog, stage);
}

async function suppressFalsePositiveReviewerResults(
  params: RunCodeReviewLoopParams,
  results: ReviewerResult[],
): Promise<ReviewerResult[]> {
  if (params.mode !== 'early-artifact' || results.length === 0) return results;

  const stage = stageForLoopParams(params);
  const catalog = await fetchFalsePositivesCatalog(
    params.product,
    params.githubToken,
    params.fetchFn,
  );
  if (catalog.length === 0) return results;

  return results.map((result) => {
    if (!result.findings || !result.commentBody) return result;
    const transformed = suppressFalsePositiveReviewerComment(
      {
        kind: result.kind,
        reviewContent: result.commentBody,
        findings: result.findings,
      },
      catalog,
      stage,
    );
    return {
      ...result,
      findings: transformed.findings,
      commentBody: transformed.reviewContent,
    };
  });
}

type ExternalReviewLoopOutcome =
  | { kind: 'continue'; external: ExternalReviewResult }
  | {
      kind: 'defer';
      reason: 'analysis_pending';
      providerReason?: string;
    }
  | {
      kind: 'escalate';
      reason: StopRuleEscalationReason;
      message: string;
      externalReason?: string;
      evidence?: HaystackSkipEvidence;
    };

async function runExternalReviewWithStopRule(
  params: RunCodeReviewLoopParams,
  loopConfig: ReturnType<typeof resolveReviewLoopConfig>,
): Promise<ExternalReviewLoopOutcome> {
  const sleepFn = params.sleep ?? defaultSleep;
  const provider = params.product.review?.external?.provider;
  const externalCtx = buildExternalReviewContext(params);
  let skipAttempt = 0;

  while (true) {
    skipAttempt += 1;
    const external = await runExternalReviewIfConfigured(
      params.product,
      params.prUrl,
      params.externalReviewDeps,
      params.targetRevision,
    );

    let evidence: HaystackSkipEvidence | null = null;
    if (provider === 'haystack' && externalCtx) {
      const shouldCheckEvidence =
        external.status === 'escalate' ||
        (external.status === 'skipped' && external.reason !== 'not_configured');
      if (shouldCheckEvidence) {
        evidence = await fetchHaystackSkipEvidence(
          externalCtx,
          params.externalReviewDeps?.runHaystack,
        );
      }
    }

    const decision = evaluateExternalReviewStopRule({
      result: external,
      skipAttempt,
      maxSkipAttempts: loopConfig.noProgressCycles,
      evidence,
    });

    if (decision.action === 'continue') {
      return { kind: 'continue', external: decision.result };
    }

    if (decision.action === 'defer') {
      return {
        kind: 'defer',
        reason: decision.reason,
        providerReason: decision.providerReason,
      };
    }

    if (decision.action === 'escalate') {
      return {
        kind: 'escalate',
        reason: decision.reason,
        message: decision.message,
        externalReason: decision.externalReason,
        evidence: decision.evidence,
      };
    }

    await sleepFn(externalRetryDelayMs(params.product));
  }
}

/** Formats external adapter blockers for the code-remediator prompt. */
export function formatExternalBlockersForRemediation(blockers: NormalizedFinding[]): string {
  return blockers
    .map((finding) => {
      const lines = [`- **${finding.severity.toUpperCase()}**: ${finding.summary}`];
      if (finding.path) lines.push(`  - File: ${finding.path}`);
      if (finding.detail) lines.push(`  - ${finding.detail}`);
      if (finding.fixHint) lines.push(`  - Fix: ${finding.fixHint}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Bounded internal fanout ↔ remediate loop (ADR-036), then optional external review
 * when configured (Haystack via HaystackExternalReviewAdapter).
 */
export async function runCodeReviewLoop(
  params: RunCodeReviewLoopParams,
): Promise<CodeReviewLoopResult> {
  const loopConfig = resolveReviewLoopConfig(params.product);
  let totalCost = 0;
  let maxDuration = 0;
  let cycle = 1;
  let noProgressStreak = 0;
  let bestBlockerCount: number | null = null;
  // Separate lanes: internal title fingerprints ≠ external NormalizedFinding.id.
  const internalSticky = createStickyLane();
  const externalSticky = createStickyLane();
  let lastFanout: ReviewerFanoutResult | null = null;
  let ranRemediation = false;

  while (true) {
    while (true) {
      const transformReviewComment = await buildFalsePositiveReviewerCommentTransform(params);
      const fanoutResult = await fanoutReviewers(
        params.externalId,
        params.product,
        params.prUrl,
        params.githubToken,
        params.runtime,
        params.runGit,
        params.runGh,
        params.fetchFn,
        params.codeRepo,
        params.branchName,
        transformReviewComment,
      );
      lastFanout = fanoutResult;
      totalCost += fanoutResult.costUsd;
      maxDuration = Math.max(maxDuration, fanoutResult.durationMs);

      if (fanoutResult.status === 'error' && fanoutResult.reviewerResults.length === 0) {
        return {
          status: 'error',
          prUrl: fanoutResult.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          error: fanoutResult.error,
        };
      }

      const reviewerResults = await suppressFalsePositiveReviewerResults(
        params,
        fanoutResult.reviewerResults,
      );
      const gateFanoutResult =
        reviewerResults === fanoutResult.reviewerResults
          ? fanoutResult
          : { ...fanoutResult, reviewerResults };

      if (!shouldRemediate(gateFanoutResult.reviewerResults, loopConfig.remediateSeverity)) {
        break;
      }

      const blockerCount = countBlockingFindings(
        gateFanoutResult.reviewerResults,
        loopConfig.remediateSeverity,
      );
      const currentFingerprints = collectGateFindingFingerprints(
        gateFanoutResult.reviewerResults,
        loopConfig.remediateSeverity,
      );
      const stickyRemaining = observeStickyLane(internalSticky, currentFingerprints);
      noProgressStreak = nextNoProgressStreak(
        bestBlockerCount,
        blockerCount,
        noProgressStreak,
        internalSticky.bestRemaining,
        stickyRemaining,
      );
      if (bestBlockerCount === null || blockerCount < bestBlockerCount) {
        bestBlockerCount = blockerCount;
      }
      recordStickyImprovement(internalSticky, stickyRemaining);

      const stop = evaluateStopRule({
        cycle,
        maxCycles: loopConfig.maxCycles,
        noProgressCycles: loopConfig.noProgressCycles,
        noProgressStreak,
      });
      if (stop.escalate) {
        return {
          status: 'error',
          prUrl: fanoutResult.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          escalated: true,
          escalationReason: stop.reason,
          error: escalationMessage(stop.reason, cycle, loopConfig.noProgressCycles),
        };
      }

      const remediationOutcome = await runRemediationPass({
        ...params,
        fanoutResult: gateFanoutResult,
        totalCost,
        maxDuration,
        loopConfig,
        fetchFn: params.fetchFn,
        resolvedProductDecisions: params.resolvedProductDecisions,
        loadResolvedProductDecisions: params.loadResolvedProductDecisions,
        stageTransitions: params.mode === 'early-artifact' ? 'none' : 'code-review',
      });
      ranRemediation = true;
      totalCost = remediationOutcome.totalCost;
      maxDuration = remediationOutcome.maxDuration;

      if (remediationOutcome.status === 'error') {
        const adjudicationEscalation = remediationErrorToLoopResult(
          fanoutResult.prUrl,
          remediationOutcome,
          cycle,
          totalCost,
          maxDuration,
        );
        if (adjudicationEscalation.escalated) {
          await postEscalationCommentBestEffort(params, {
            reason: 'adjudication_conflict',
            message: adjudicationEscalation.error ?? 'Adjudication conflict',
            cyclesCompleted: cycle,
          });
        }
        return adjudicationEscalation;
      }

      cycle += 1;
    }

    const fanout = lastFanout!;
    const externalOutcome = await runExternalReviewWithStopRule(params, loopConfig);
    if (externalOutcome.kind === 'defer') {
      const provider = params.product.review?.external?.provider;
      const prRef = parsePullRequestRef(params.prUrl);
      if (!provider || !prRef) {
        return {
          status: 'error',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          error: 'External review deferred but review identity could not be resolved',
        };
      }
      if (!params.targetRevision) {
        return {
          status: 'error',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          error: 'External review deferred but target revision was not recorded',
        };
      }
      if (!params.onExternalReviewDeferred) {
        return {
          status: 'error',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          error: 'External review deferred but persistence hook is not configured',
        };
      }
      const deferredExternalReview: DeferredExternalReviewIntent = {
        productSlug: params.product.product.slug,
        externalId: params.externalId,
        specialistId:
          params.mode === 'early-artifact' && params.kind
            ? `${params.kind}-draft-reviewer`
            : 'reviewer-fanout',
        provider,
        reason: externalOutcome.reason,
        providerReason: externalOutcome.providerReason,
        prNumber: prRef.prNumber,
        targetRevision: params.targetRevision,
        maxDeferSec: externalMaxDeferSec(params.product),
      };
      try {
        await params.onExternalReviewDeferred(deferredExternalReview);
      } catch (err) {
        return {
          status: 'error',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          error: `External review deferred but intent persistence failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      return {
        status: 'deferred',
        prUrl: fanout.prUrl,
        costUsd: totalCost,
        durationMs: maxDuration,
        cyclesCompleted: cycle,
        deferredExternalReview,
      };
    }

    if (externalOutcome.kind === 'escalate') {
      await postEscalationCommentBestEffort(params, {
        reason: externalOutcome.reason,
        message: externalOutcome.message,
        cyclesCompleted: cycle,
        evidence: externalOutcome.evidence,
        externalReason: externalOutcome.externalReason,
      });
      return {
        status: 'error',
        prUrl: fanout.prUrl,
        costUsd: totalCost,
        durationMs: maxDuration,
        cyclesCompleted: cycle,
        escalated: true,
        escalationReason: externalOutcome.reason,
        error: externalOutcome.message,
      };
    }

    const external = externalOutcome.external;

    if (external.status === 'needs_fixes') {
      const { blockers, suppressed } = await suppressFalsePositiveExternalFindings(
        params,
        external.blockers,
      );
      if (blockers.length === 0) {
        if (suppressed.length > 0 || external.advisories.length > 0) {
          await postReviewLoopSummaryBestEffort(params, {
            cyclesCompleted: cycle,
            advisories: [...suppressed, ...external.advisories],
            stage: stageForLoopParams(params),
            externalProvider: params.product.review?.external?.provider,
          });
        }
        if (fanout.status === 'error') {
          return {
            status: 'error',
            prUrl: fanout.prUrl,
            costUsd: totalCost,
            durationMs: maxDuration,
            cyclesCompleted: cycle,
            newStage:
              ranRemediation && params.mode !== 'early-artifact' ? 'code-review' : undefined,
            error: `Reviewer fan-out reported an error (reviewer coverage may be incomplete): ${fanout.error}`,
          };
        }
        return {
          status: 'done',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          newStage: ranRemediation && params.mode !== 'early-artifact' ? 'code-review' : undefined,
        };
      }

      const blockerCount = blockers.length;
      const currentFingerprints = new Set(blockers.map((finding) => finding.id));
      const stickyRemaining = observeStickyLane(externalSticky, currentFingerprints);
      noProgressStreak = nextNoProgressStreak(
        bestBlockerCount,
        blockerCount,
        noProgressStreak,
        externalSticky.bestRemaining,
        stickyRemaining,
      );
      if (bestBlockerCount === null || blockerCount < bestBlockerCount) {
        bestBlockerCount = blockerCount;
      }
      recordStickyImprovement(externalSticky, stickyRemaining);

      const stop = evaluateStopRule({
        cycle,
        maxCycles: loopConfig.maxCycles,
        noProgressCycles: loopConfig.noProgressCycles,
        noProgressStreak,
      });
      if (stop.escalate) {
        return {
          status: 'error',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          escalated: true,
          escalationReason: stop.reason,
          error: escalationMessage(stop.reason, cycle, loopConfig.noProgressCycles),
        };
      }

      const remediationOutcome = await runRemediationPass({
        ...params,
        fanoutResult: fanout,
        totalCost,
        maxDuration,
        externalFindingsBody: formatExternalBlockersForRemediation(blockers),
        loopConfig,
        fetchFn: params.fetchFn,
        resolvedProductDecisions: params.resolvedProductDecisions,
        loadResolvedProductDecisions: params.loadResolvedProductDecisions,
        stageTransitions: params.mode === 'early-artifact' ? 'none' : 'code-review',
      });
      ranRemediation = true;
      totalCost = remediationOutcome.totalCost;
      maxDuration = remediationOutcome.maxDuration;

      if (remediationOutcome.status === 'error') {
        const adjudicationEscalation = remediationErrorToLoopResult(
          fanout.prUrl,
          remediationOutcome,
          cycle,
          totalCost,
          maxDuration,
        );
        if (adjudicationEscalation.escalated) {
          await postEscalationCommentBestEffort(params, {
            reason: 'adjudication_conflict',
            message: adjudicationEscalation.error ?? 'Adjudication conflict',
            cyclesCompleted: cycle,
          });
        }
        return adjudicationEscalation;
      }

      cycle += 1;
      continue;
    }

    if (fanout.status === 'error') {
      return {
        status: 'error',
        prUrl: fanout.prUrl,
        costUsd: totalCost,
        durationMs: maxDuration,
        cyclesCompleted: cycle,
        newStage: ranRemediation ? 'code-review' : undefined,
        error: `Reviewer fan-out reported an error (reviewer coverage may be incomplete): ${fanout.error}`,
      };
    }

    if (external.status === 'clean' && external.advisories.length > 0) {
      await postReviewLoopSummaryBestEffort(params, {
        cyclesCompleted: cycle,
        advisories: external.advisories,
        stage:
          params.mode === 'early-artifact'
            ? params.kind === 'spec'
              ? 'spec-draft'
              : 'plan-draft'
            : 'code-review',
        externalProvider: params.product.review?.external?.provider,
      });
    }

    return {
      status: 'done',
      prUrl: fanout.prUrl,
      costUsd: totalCost,
      durationMs: maxDuration,
      cyclesCompleted: cycle,
      newStage: ranRemediation && params.mode !== 'early-artifact' ? 'code-review' : undefined,
    };
  }
}

export async function runEarlyArtifactReviewLoop(
  params: Omit<RunCodeReviewLoopParams, 'codeRepo' | 'mode'> & { kind: 'spec' | 'plan' },
): Promise<CodeReviewLoopResult> {
  const knowledgeRepoAsCodeRepo: CodeRepo = {
    url: params.product.knowledge_repo.url,
    default_branch: params.product.knowledge_repo.default_branch,
    role: 'docs',
  };
  const branchName =
    params.kind === 'spec' ? `helm/spec/${params.externalId}` : `helm/plan/${params.externalId}`;

  const result = await runCodeReviewLoop({
    ...params,
    codeRepo: knowledgeRepoAsCodeRepo,
    branchName,
    mode: 'early-artifact',
  });

  return { ...result, prUrl: params.prUrl, newStage: undefined };
}

type RemediationPassOutcome =
  | { status: 'done'; totalCost: number; maxDuration: number }
  | {
      status: 'error';
      totalCost: number;
      maxDuration: number;
      newStage?: 'code-review' | 'remediation';
      error: string;
    };

type AdjudicationPassOutcome =
  | { status: 'skipped' }
  | {
      status: 'auto_remediate';
      totalCost: number;
      maxDuration: number;
      unifiedPlan: string;
    }
  | {
      status: 'human_required';
      totalCost: number;
      maxDuration: number;
      message: string;
    }
  | {
      status: 'error';
      totalCost: number;
      maxDuration: number;
      error: string;
    };

function buildFindingsByKind(
  fanoutResult: ReviewerFanoutResult,
  externalFindingsBody?: string,
): Map<ReviewerKind, string> {
  const findingsByKind = new Map<ReviewerKind, string>();

  for (const r of fanoutResult.reviewerResults) {
    if (r.commentBody) {
      findingsByKind.set(r.kind, r.commentBody);
    }
  }

  if (externalFindingsBody) {
    const externalSection = ['## External review blockers', '', externalFindingsBody].join('\n');
    const existingCode = findingsByKind.get('code');
    findingsByKind.set(
      'code',
      existingCode ? `${existingCode}\n\n${externalSection}` : externalSection,
    );
  }

  return findingsByKind;
}

async function runAdjudicationPass(input: {
  externalId: string;
  product: Product;
  prUrl: string;
  codeRepo: CodeRepo;
  branchName?: string;
  mode?: 'code' | 'early-artifact';
  kind?: 'spec' | 'plan';
  githubToken: string;
  runtime: IAgentRuntime;
  runGit?: RunGit;
  runGh?: RunGh;
  fanoutResult: ReviewerFanoutResult;
  totalCost: number;
  maxDuration: number;
  externalFindingsBody?: string;
  fetchFn?: FetchFn;
  resolvedProductDecisions?: StoredResolvedProductDecision[];
}): Promise<AdjudicationPassOutcome> {
  let workspacePath = '';
  try {
    const provisioned = await provisionReviewerWorkspace(
      {
        externalId: input.externalId,
        codeRepo: input.codeRepo,
        branchName: input.branchName,
        githubToken: input.githubToken,
      },
      input.runGit,
    );
    workspacePath = provisioned.workspacePath;

    const findingsByKind = buildFindingsByKind(input.fanoutResult, input.externalFindingsBody);
    let spec: string | undefined;
    let draftArtifact:
      | {
          kind: 'spec' | 'plan';
          content: string;
        }
      | undefined;
    if (input.mode === 'early-artifact' && input.kind) {
      if (!EXTERNAL_ID_SAFE.test(input.externalId)) {
        throw new Error('Invalid externalId for draft artifact path');
      }
      const artifactRelPath =
        input.kind === 'spec' ? `specs/${input.externalId}.md` : `plans/${input.externalId}.md`;
      try {
        draftArtifact = {
          kind: input.kind,
          content: await readFile(join(workspacePath, artifactRelPath), 'utf-8'),
        };
      } catch (err) {
        if (!isEnoentError(err)) throw err;
        throw new Error(`Draft ${input.kind} artifact not found at ${artifactRelPath}`);
      }
    } else {
      try {
        spec =
          (await fetchSpecForPlan(
            input.product,
            input.externalId,
            input.githubToken,
            input.fetchFn ?? fetch,
          )) ?? undefined;
      } catch (err) {
        if (!isEnoentError(err)) {
          throw err;
        }
        spec = undefined;
      }
    }

    const params = buildReviewAdjudicatorParams(
      input.externalId,
      input.product,
      workspacePath,
      input.prUrl,
      findingsByKind,
      {
        spec,
        draftArtifact,
        resolvedProductDecisions: input.resolvedProductDecisions,
        codeRepo: input.codeRepo,
        branchName: input.branchName,
      },
    );
    const session = await input.runtime.spawn(params);
    const agentResult = await session.wait();
    const adjudicationResult = await handleReviewAdjudicatorResult(
      input.externalId,
      agentResult,
      workspacePath,
      input.prUrl,
      input.githubToken,
      input.runGh,
      input.resolvedProductDecisions ?? [],
    );

    const totalCost = input.totalCost + adjudicationResult.costUsd;
    const maxDuration = Math.max(input.maxDuration, adjudicationResult.durationMs);

    if (adjudicationResult.status !== 'done' || !adjudicationResult.parsed) {
      return {
        status: 'error',
        totalCost,
        maxDuration,
        error: adjudicationResult.error ?? 'Review adjudication failed',
      };
    }

    // Settled conflicts were already suppressed before the PR comment was posted.
    const parsed = adjudicationResult.parsed;

    if (parsed.status === 'HUMAN_REQUIRED') {
      return {
        status: 'human_required',
        totalCost,
        maxDuration,
        message:
          'Review-adjudicator reported unresolved product or documentation conflicts — see the adjudication PR comment for options.',
      };
    }

    return {
      status: 'auto_remediate',
      totalCost,
      maxDuration,
      unifiedPlan: parsed.unifiedPlan,
    };
  } catch (err) {
    console.error(
      '[code-review-loop] Review adjudication failed:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      status: 'error',
      totalCost: input.totalCost,
      maxDuration: input.maxDuration,
      error: 'Review adjudication failed',
    };
  } finally {
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
      await rm(artifactsDirFor(workspacePath), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function remediationErrorToLoopResult(
  fanoutPrUrl: string,
  remediationOutcome: Extract<RemediationPassOutcome, { status: 'error' }>,
  cycle: number,
  totalCost: number,
  maxDuration: number,
): CodeReviewLoopResult {
  if (remediationOutcome.error?.startsWith('adjudication_conflict:')) {
    const message = remediationOutcome.error.replace(/^adjudication_conflict:\s*/, '');
    return {
      status: 'error',
      prUrl: fanoutPrUrl,
      costUsd: totalCost,
      durationMs: maxDuration,
      cyclesCompleted: cycle,
      escalated: true,
      escalationReason: 'adjudication_conflict',
      newStage: remediationOutcome.newStage,
      error: message,
    };
  }

  return {
    status: 'error',
    prUrl: fanoutPrUrl,
    costUsd: totalCost,
    durationMs: maxDuration,
    cyclesCompleted: cycle,
    newStage: remediationOutcome.newStage,
    error: remediationOutcome.error,
  };
}

async function resolveSettledDecisions(input: {
  resolvedProductDecisions?: StoredResolvedProductDecision[];
  loadResolvedProductDecisions?: () => Promise<StoredResolvedProductDecision[]>;
}): Promise<StoredResolvedProductDecision[]> {
  if (input.loadResolvedProductDecisions) {
    // Fail closed: never fall back to the enqueue-time snapshot after a live
    // reload error — that would reopen conflicts already settled on disk.
    const decisions = await input.loadResolvedProductDecisions();
    return [...decisions];
  }
  return [...(input.resolvedProductDecisions ?? [])];
}

async function runAdjudicationIfEnabled(input: {
  externalId: string;
  product: Product;
  prUrl: string;
  codeRepo: CodeRepo;
  branchName?: string;
  mode?: 'code' | 'early-artifact';
  kind?: 'spec' | 'plan';
  githubToken: string;
  runtime: IAgentRuntime;
  runGit?: RunGit;
  runGh?: RunGh;
  fanoutResult: ReviewerFanoutResult;
  totalCost: number;
  maxDuration: number;
  externalFindingsBody?: string;
  fetchFn?: FetchFn;
  loopConfig: ReviewLoopConfig;
  resolvedProductDecisions?: StoredResolvedProductDecision[];
  loadResolvedProductDecisions?: () => Promise<StoredResolvedProductDecision[]>;
}): Promise<AdjudicationPassOutcome> {
  if (!input.loopConfig.adjudicationEnabled) {
    return { status: 'skipped' };
  }
  let resolvedProductDecisions: StoredResolvedProductDecision[];
  try {
    resolvedProductDecisions = await resolveSettledDecisions(input);
  } catch (err) {
    // Keep filesystem/path details out of DispatchResult.error (returned via jobs API).
    console.error(
      '[code-review-loop] Failed to reload settled product decisions:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      status: 'error',
      totalCost: input.totalCost,
      maxDuration: input.maxDuration,
      error: 'Failed to reload settled product decisions',
    };
  }
  return runAdjudicationPass({ ...input, resolvedProductDecisions });
}

/**
 * After a failed remediation pass the item may still be in `remediation`, which
 * has no STAGE_TO_SPECIALIST mapping. Best-effort return to `code-review` so the
 * operator (or webhook re-dispatch) can retry without manual stage repair.
 */
async function recoverToCodeReviewAfterRemediationFailure(
  externalId: string,
  transition: ItemTransitionFn,
): Promise<'code-review' | 'remediation'> {
  try {
    await transition({
      externalId,
      toStage: 'code-review',
      triggeredBy: 'specialist:remediation-recovery',
    });
    return 'code-review';
  } catch {
    return 'remediation';
  }
}

async function runRemediationPass(input: {
  externalId: string;
  product: Product;
  prUrl: string;
  codeRepo: CodeRepo;
  branchName?: string;
  mode?: 'code' | 'early-artifact';
  kind?: 'spec' | 'plan';
  githubToken: string;
  runtime: IAgentRuntime;
  transition: ItemTransitionFn;
  runGit?: RunGit;
  runGh?: RunGh;
  fanoutResult: ReviewerFanoutResult;
  totalCost: number;
  maxDuration: number;
  externalFindingsBody?: string;
  loopConfig: ReviewLoopConfig;
  fetchFn?: FetchFn;
  resolvedProductDecisions?: StoredResolvedProductDecision[];
  loadResolvedProductDecisions?: () => Promise<StoredResolvedProductDecision[]>;
  stageTransitions?: 'code-review' | 'none';
}): Promise<RemediationPassOutcome> {
  let totalCost = input.totalCost;
  let maxDuration = input.maxDuration;

  const adjudication = await runAdjudicationIfEnabled({
    externalId: input.externalId,
    product: input.product,
    prUrl: input.prUrl,
    codeRepo: input.codeRepo,
    branchName: input.branchName,
    mode: input.mode,
    kind: input.kind,
    githubToken: input.githubToken,
    runtime: input.runtime,
    runGit: input.runGit,
    runGh: input.runGh,
    fanoutResult: input.fanoutResult,
    totalCost,
    maxDuration,
    externalFindingsBody: input.externalFindingsBody,
    fetchFn: input.fetchFn,
    loopConfig: input.loopConfig,
    resolvedProductDecisions: input.resolvedProductDecisions,
    loadResolvedProductDecisions: input.loadResolvedProductDecisions,
  });

  if (adjudication.status === 'human_required') {
    return {
      status: 'error',
      totalCost: adjudication.totalCost,
      maxDuration: adjudication.maxDuration,
      newStage: 'code-review',
      error: `adjudication_conflict: ${adjudication.message}`,
    };
  }

  if (adjudication.status === 'error') {
    return {
      status: 'error',
      totalCost: adjudication.totalCost,
      maxDuration: adjudication.maxDuration,
      newStage: 'code-review',
      error: adjudication.error,
    };
  }

  if (adjudication.status === 'auto_remediate') {
    totalCost = adjudication.totalCost;
    maxDuration = adjudication.maxDuration;
  }

  const adjudicationPlan =
    adjudication.status === 'auto_remediate' ? adjudication.unifiedPlan : undefined;

  let remediationWorkspace = '';
  try {
    const provisioned = await provisionReviewerWorkspace(
      {
        externalId: input.externalId,
        codeRepo: input.codeRepo,
        branchName: input.branchName,
        githubToken: input.githubToken,
      },
      input.runGit,
    );
    remediationWorkspace = provisioned.workspacePath;
  } catch (err) {
    return {
      status: 'error',
      totalCost: input.totalCost,
      maxDuration: input.maxDuration,
      newStage: input.stageTransitions === 'none' ? undefined : 'code-review',
      error: `Failed to provision remediation workspace: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    try {
      if (input.stageTransitions !== 'none') {
        await input.transition({
          externalId: input.externalId,
          toStage: 'remediation',
          triggeredBy: 'specialist:remediation',
        });
      }
    } catch (err) {
      return {
        status: 'error',
        totalCost: input.totalCost,
        maxDuration: input.maxDuration,
        newStage: 'code-review',
        error: `Failed to transition to remediation: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const findingsByKind = buildFindingsByKind(input.fanoutResult, input.externalFindingsBody);

    const params = buildRemediationParams(
      input.externalId,
      input.product,
      remediationWorkspace,
      input.prUrl,
      findingsByKind,
      adjudicationPlan,
      input.codeRepo,
      input.branchName,
    );

    let remediationResult: RemediationResult | undefined;
    let returnedToCodeReviewDuringRetry = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await input.runtime.spawn(params);
      const agentResult = await session.wait();

      remediationResult = await handleRemediationResult(
        input.externalId,
        agentResult,
        remediationWorkspace,
        input.prUrl,
        input.githubToken,
        input.codeRepo,
        input.runGit,
        input.runGh,
        input.branchName,
      );

      totalCost += remediationResult.costUsd;
      maxDuration = Math.max(maxDuration, remediationResult.durationMs);

      if (remediationResult.status === 'done') {
        break;
      }

      if (attempt === 0 && input.stageTransitions !== 'none') {
        const recoveredStage = await recoverToCodeReviewAfterRemediationFailure(
          input.externalId,
          input.transition,
        );
        returnedToCodeReviewDuringRetry = recoveredStage === 'code-review';
        continue;
      }
    }

    if (!remediationResult || remediationResult.status !== 'done') {
      if (input.stageTransitions === 'none') {
        return {
          status: 'error',
          totalCost,
          maxDuration,
          error: remediationResult?.error ?? 'Remediation failed',
        };
      }
      const newStage = await recoverToCodeReviewAfterRemediationFailure(
        input.externalId,
        input.transition,
      );
      const baseError = remediationResult?.error ?? 'Remediation failed';
      return {
        status: 'error',
        totalCost,
        maxDuration,
        newStage,
        error:
          newStage === 'remediation'
            ? `${baseError} (remediation-recovery also failed)`
            : baseError,
      };
    }

    if (!returnedToCodeReviewDuringRetry && input.stageTransitions !== 'none') {
      try {
        await input.transition({
          externalId: input.externalId,
          toStage: 'code-review',
          triggeredBy: 'specialist:remediation',
        });
      } catch (err) {
        const newStage = await recoverToCodeReviewAfterRemediationFailure(
          input.externalId,
          input.transition,
        );
        const baseError = `Failed to transition back to code-review: ${err instanceof Error ? err.message : String(err)}`;
        return {
          status: 'error',
          totalCost,
          maxDuration,
          newStage,
          error:
            newStage === 'remediation'
              ? `${baseError} (remediation-recovery also failed)`
              : baseError,
        };
      }
    }

    if (input.fanoutResult.status === 'error') {
      return {
        status: 'error',
        totalCost,
        maxDuration,
        newStage: input.stageTransitions === 'none' ? undefined : 'code-review',
        error: `Remediation succeeded, but the reviewer fan-out reported an error (reviewer coverage may be incomplete): ${input.fanoutResult.error}`,
      };
    }

    return { status: 'done', totalCost, maxDuration };
  } finally {
    await rm(remediationWorkspace, { recursive: true, force: true }).catch(() => {});
    await rm(artifactsDirFor(remediationWorkspace), { recursive: true, force: true }).catch(
      () => {},
    );
  }
}

export { buildFindingsByKind };
