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
import type { ExternalReviewResult, NormalizedFinding } from '../external-review/types.js';
import { defaultSleep } from '../lib/sleep.js';
import { resolveReviewLoopConfig, type ReviewLoopConfig } from './config.js';
import { upsertReviewLoopEscalationComment } from './escalation-comment.js';
import { evaluateExternalReviewStopRule } from './external-stop-rule.js';
import {
  fetchFalsePositivesCatalog,
  matchesFalsePositiveFinding,
  type FalsePositiveEntry,
} from './false-positives.js';
import { catalogEntriesForStage } from './catalog-prompt.js';
import {
  acceptedFindingMatchesExternal,
  acceptedFindingMatchesTitle,
  type StoredAcceptedFinding,
} from './accept-finding.js';
import { upsertReviewLoopSummaryComment } from './summary.js';
import {
  countBlockingFindings,
  evaluateStopRule,
  nextNoProgressStreak,
  type StopRuleEscalationReason,
} from './stop-rule.js';
import {
  seedFromReviewLoopLedger,
  type PersistReviewLoopLedgerFn,
  type ReviewLoopLane,
  type ReviewLoopLedgerEntry,
  type ReviewLoopLedgerUpdate,
} from './cumulative-ledger.js';
import {
  collectGateFindings,
  createStickyLane,
  observeStickyLane,
  recordStickyFindings,
  recordStickyImprovement,
  unresolvedStickyFindings,
  type StickyFindingRecord,
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
  /** Findings a maintainer dismissed on this item (ADR-043 §4). */
  acceptedFindings?: StoredAcceptedFinding[];
  /**
   * Optional per-cycle loader for accepted findings, so an accept posted while
   * this job is still running takes effect on the next pass.
   */
  loadAcceptedFindings?: () => Promise<StoredAcceptedFinding[]>;
  targetRevision?: string;
  onExternalReviewDeferred?: (intent: DeferredExternalReviewIntent) => Promise<void> | void;
  mode?: 'code' | 'early-artifact';
  /**
   * Durable cross-dispatch counters for this item's lane (ADR-042). Seeds the
   * lifetime budget so a manual re-dispatch does not restart it at zero.
   */
  reviewLoopLedgerEntry?: ReviewLoopLedgerEntry;
  /** Writes the lane's counters back after each pass and on escalation (ADR-042). */
  persistReviewLoopLedger?: PersistReviewLoopLedgerFn;
};

function escalationMessage(
  reason: StopRuleEscalationReason,
  cyclesCompleted: number,
  noProgressCycles?: number,
  cumulative?: { cycles: number; budget: number },
): string {
  if (reason === 'max_cycles') {
    return `Review loop escalated: reached max_cycles (${cyclesCompleted}) with CRITICAL/HIGH findings still open`;
  }
  if (reason === 'max_cycles_cumulative') {
    const cycles = cumulative?.cycles ?? cyclesCompleted;
    const budget = cumulative?.budget ?? cycles;
    return `Review loop escalated: lifetime review budget exhausted — the next remediation pass would be cumulative cycle ${cycles} of max_cycles_cumulative=${budget} for this item, with CRITICAL/HIGH findings still open (${cyclesCompleted} cycle(s) in this dispatch)`;
  }
  if (reason === 'no_progress') {
    const threshold = noProgressCycles === undefined ? cyclesCompleted : noProgressCycles;
    const carried =
      cumulative && cumulative.cycles > cyclesCompleted
        ? ` — the streak spans dispatches (${cumulative.cycles} cumulative cycle(s))`
        : '';
    return `Review loop escalated: no progress on blocking findings for ${threshold} consecutive remediation cycle(s) (${cyclesCompleted} cycle(s) completed)${carried}`;
  }
  if (reason === 'adjudication_conflict') {
    return `Review loop escalated: review-adjudicator requires human product or documentation decisions (${cyclesCompleted} cycle(s) completed)`;
  }
  if (reason === 'external_escalate') {
    return `Review loop escalated: external review returned escalate (${cyclesCompleted} cycle(s) completed)`;
  }
  return `Review loop escalated: external review skipped repeatedly (${cyclesCompleted} cycle(s) completed)`;
}

/** Backoff between external-review retries after a skipped result (ADR-036 §6). */
const EXTERNAL_REVIEW_RETRY_DELAY_MS = 15_000;

function externalMaxDeferSec(product: Product): number {
  return product.review?.external?.max_defer_sec ?? 30 * 60;
}

/**
 * Upserts the escalation comment by marker (lhpaul/helm#93) instead of appending:
 * a still-blocked item re-escalates on every re-dispatch, so appending buried the
 * PR under identical comments. The comment always carries the latest reason,
 * cycle counts, and external signal.
 */
async function postEscalationCommentBestEffort(
  params: RunCodeReviewLoopParams,
  input: {
    reason: StopRuleEscalationReason;
    message: string;
    cyclesCompleted: number;
    externalReason?: string;
    cumulative?: { cyclesTotal: number; maxCyclesCumulative: number };
  },
): Promise<void> {
  try {
    // Rendering happens inside the upsert, and the upsert is inside the try:
    // a rendering slip must not swallow the escalation result itself.
    await upsertReviewLoopEscalationComment({
      ...input,
      prUrl: params.prUrl,
      githubToken: params.githubToken,
      runGh: params.runGh,
    });
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
    catalog: FalsePositiveEntry[];
    externalProvider?: string;
    acceptedFindings?: readonly StoredAcceptedFinding[];
  },
): Promise<void> {
  if (input.advisories.length === 0) return;

  try {
    await upsertReviewLoopSummaryComment({
      prUrl: params.prUrl,
      githubToken: params.githubToken,
      cyclesCompleted: input.cyclesCompleted,
      externalProvider: input.externalProvider,
      advisories: input.advisories,
      catalog: input.catalog,
      stage: input.stage,
      acceptedFindings: input.acceptedFindings,
      runGh: params.runGh,
    });
  } catch {
    // Best-effort — clean loop exit is still valid without the summary comment.
  }
}

/** The lane this run belongs to — also the false-positive catalog stage key. */
/**
 * Latest accepted findings for this item (ADR-043 §4).
 *
 * Fails *open* to the value already in hand, unlike settled decisions: an accept
 * only ever removes work, so a transient read error must not resurrect a finding
 * the operator already dismissed mid-run. On the very first read there is
 * nothing in hand, so the enqueue-time snapshot is used.
 */
async function resolveAcceptedFindings(
  params: RunCodeReviewLoopParams,
  current?: StoredAcceptedFinding[],
): Promise<StoredAcceptedFinding[]> {
  const fallback = current ?? [...(params.acceptedFindings ?? [])];
  if (!params.loadAcceptedFindings) return fallback;
  try {
    return [...(await params.loadAcceptedFindings())];
  } catch (err) {
    console.error(
      '[code-review-loop] Failed to reload accepted findings:',
      err instanceof Error ? err.message : String(err),
    );
    return fallback;
  }
}

function stageForLoopParams(params: RunCodeReviewLoopParams): ReviewLoopLane {
  if (params.mode !== 'early-artifact') return 'code-review';
  return params.kind === 'spec' ? 'spec-draft' : 'plan-draft';
}

/**
 * Writes the lane's cross-dispatch counters back (ADR-042).
 *
 * Retried once, then best-effort: a failed ledger write must not abort a run
 * that has already pushed remediation commits and moved the item's stage. The
 * cost of giving up is a budget that under-counts — the monotonic clamp in
 * ItemStore means the next successful write still carries the higher total.
 */
async function persistLedgerBestEffort(
  params: RunCodeReviewLoopParams,
  update: ReviewLoopLedgerUpdate,
): Promise<void> {
  if (!params.persistReviewLoopLedger) return;
  const lane = stageForLoopParams(params);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await params.persistReviewLoopLedger({ lane, update });
      return;
    } catch (err) {
      if (attempt === 0) continue;
      console.error(
        '[code-review-loop] Failed to persist review-loop ledger:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function findFalsePositiveMatch(
  finding: NormalizedFinding,
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
): FalsePositiveEntry | undefined {
  return catalogEntriesForStage(catalog, stage).find((entry) =>
    matchesFalsePositiveFinding(entry, finding),
  );
}

async function suppressFalsePositiveExternalFindings(
  params: RunCodeReviewLoopParams,
  findings: NormalizedFinding[],
  catalog: FalsePositiveEntry[],
  acceptedFindings: readonly StoredAcceptedFinding[] = [],
): Promise<{ blockers: NormalizedFinding[]; suppressed: NormalizedFinding[] }> {
  if (findings.length === 0) return { blockers: [], suppressed: [] };

  const stage = stageForLoopParams(params);
  const blockers: NormalizedFinding[] = [];
  const suppressed: NormalizedFinding[] = [];

  for (const finding of findings) {
    const accepted =
      isSuppressibleOnCodePr(finding.severity) &&
      acceptedFindingMatchesExternal(acceptedFindings, finding);
    if (accepted || findFalsePositiveMatch(finding, catalog, stage)) {
      suppressed.push({ ...finding, blocking: false });
    } else {
      blockers.push(finding);
    }
  }

  return { blockers, suppressed };
}

/**
 * Severities a catalogue match may demote on a code PR (ADR-043 §1).
 *
 * ADR-041 §4 declined catalogued gate suppression on code PRs entirely, because
 * catalogue matching is heuristic token overlap and silently clearing a real
 * security HIGH is worse than one extra deferral cycle. That reasoning holds at
 * CRITICAL/HIGH and only there — the LEA-246 churn was a MEDIUM coverage
 * opinion. The cap is what makes ADR-043 an amendment rather than an override.
 *
 * `early-artifact` mode stays uncapped: a draft spec or plan carries no shipping
 * code to protect (ADR-040).
 */
const CODE_REVIEW_SUPPRESSIBLE_SEVERITIES: ReadonlySet<NormalizedFinding['severity']> = new Set([
  'medium',
  'low',
  'info',
]);

function isSuppressibleOnCodePr(severity: NormalizedFinding['severity']): boolean {
  return CODE_REVIEW_SUPPRESSIBLE_SEVERITIES.has(severity);
}

const DEMOTION_LABELS = ['Catalogued false positive:', 'Accepted by operator:'] as const;

/**
 * Demotes findings the loop must stop acting on — catalogued patterns (ADR-043
 * §1) and findings a maintainer accepted on this item (ADR-043 §4) — to INFO,
 * recounting the severity buckets and re-deriving the review status.
 *
 * Both sources share the MEDIUM ceiling on code PRs. An accept is stored only
 * for MEDIUM and below, but a fingerprint can match a later restatement filed
 * higher; the ceiling is what keeps yesterday's accepted MEDIUM from clearing
 * today's HIGH.
 */
function demotionLabelFor(
  finding: NormalizedFinding,
  summary: string,
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
  acceptedFindings: readonly StoredAcceptedFinding[],
): string | null {
  // Accept first: a named human decision on this item outranks a heuristic match.
  if (
    isSuppressibleOnCodePr(finding.severity) &&
    acceptedFindingMatchesTitle(acceptedFindings, summary)
  ) {
    return 'Accepted by operator:';
  }
  if (findFalsePositiveMatch(finding, catalog, stage)) {
    return 'Catalogued false positive:';
  }
  return null;
}

function suppressFalsePositiveReviewerComment(
  input: ReviewCommentTransformInput,
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
  acceptedFindings: readonly StoredAcceptedFinding[] = [],
): ReviewCommentTransformResult {
  const findings = { ...input.findings };
  const capped = stage === 'code-review';
  let suppressedCount = 0;
  const reviewContentWithSuppressedFindings = input.reviewContent.replace(
    /\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*\s*·\s*([^\n]+)/g,
    (line, rawSeverity: string, summary: string) => {
      if (DEMOTION_LABELS.some((label) => summary.startsWith(label))) return line;

      const severity = rawSeverity.toLowerCase() as NormalizedFinding['severity'];
      if (capped && !isSuppressibleOnCodePr(severity)) return line;

      const finding: NormalizedFinding = {
        id: `${input.kind}:${summary}`,
        severity,
        blocking: true,
        summary,
      };

      const label = demotionLabelFor(finding, summary, catalog, stage, acceptedFindings);
      if (!label) return line;
      suppressedCount += 1;
      if (findings[severity] > 0) findings[severity] -= 1;
      findings.info += 1;
      return `**INFO** · ${label} ${summary}`;
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

/**
 * Reviewer-comment transform that demotes catalogued findings before the comment
 * is posted. Runs in every mode as of ADR-043 §1 — the severity cap that keeps
 * a code PR safe lives in the transform, not in a mode guard.
 */
async function buildFalsePositiveReviewerCommentTransform(
  params: RunCodeReviewLoopParams,
  catalog: FalsePositiveEntry[],
  acceptedFindings: readonly StoredAcceptedFinding[],
): Promise<ReviewCommentTransform | undefined> {
  const stage = stageForLoopParams(params);
  if (catalog.length === 0 && acceptedFindings.length === 0) return undefined;

  return (input) => suppressFalsePositiveReviewerComment(input, catalog, stage, acceptedFindings);
}

/**
 * Applies the catalogue transform to the fan-out results the gate reads, so a
 * catalogued finding stops driving `shouldRemediate`, the blocker count, and the
 * sticky baseline — not just the PR comment text (ADR-043 §1).
 */
async function suppressFalsePositiveReviewerResults(
  params: RunCodeReviewLoopParams,
  results: ReviewerResult[],
  catalog: FalsePositiveEntry[],
  acceptedFindings: readonly StoredAcceptedFinding[] = [],
): Promise<ReviewerResult[]> {
  if (results.length === 0) return results;

  const stage = stageForLoopParams(params);
  if (catalog.length === 0 && acceptedFindings.length === 0) return results;

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
      acceptedFindings,
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
    };

async function runExternalReviewWithStopRule(
  params: RunCodeReviewLoopParams,
  loopConfig: ReturnType<typeof resolveReviewLoopConfig>,
): Promise<ExternalReviewLoopOutcome> {
  const sleepFn = params.sleep ?? defaultSleep;
  let skipAttempt = 0;

  while (true) {
    skipAttempt += 1;
    const external = await runExternalReviewIfConfigured(
      params.product,
      params.prUrl,
      params.externalReviewDeps,
      params.targetRevision,
    );

    const decision = evaluateExternalReviewStopRule({
      result: external,
      skipAttempt,
      maxSkipAttempts: loopConfig.noProgressCycles,
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
      };
    }

    await sleepFn(EXTERNAL_REVIEW_RETRY_DELAY_MS);
  }
}

/**
 * Terminal stop-rule escalation: records it on the durable ledger, tells the
 * human on the PR, and returns the loop result. Shared by the internal and
 * external branches so every stop-rule exit is visible on the PR — a
 * cumulative-budget escalation is worthless if only the job result carries it.
 */
async function escalateFromStopRule(
  params: RunCodeReviewLoopParams,
  input: {
    prUrl: string;
    reason: StopRuleEscalationReason;
    cycle: number;
    cyclesTotal: number;
    noProgressStreak: number;
    bestBlockerCount: number | null;
    loopConfig: ReviewLoopConfig;
    totalCost: number;
    maxDuration: number;
  },
): Promise<CodeReviewLoopResult> {
  const message = escalationMessage(input.reason, input.cycle, input.loopConfig.noProgressCycles, {
    // The pass the stop rule just refused — it never ran, so `cyclesTotal`
    // (completed passes) stays where it is and only the message counts it.
    cycles: input.cyclesTotal + 1,
    budget: input.loopConfig.maxCyclesCumulative,
  });

  await persistLedgerBestEffort(params, {
    cyclesTotal: input.cyclesTotal,
    noProgressStreak: input.noProgressStreak,
    bestBlockerCount: input.bestBlockerCount ?? undefined,
    escalatedAt: new Date().toISOString(),
    escalationReason: input.reason,
  });

  await postEscalationCommentBestEffort(params, {
    reason: input.reason,
    message,
    cyclesCompleted: input.cycle,
    cumulative: {
      cyclesTotal: input.cyclesTotal,
      maxCyclesCumulative: input.loopConfig.maxCyclesCumulative,
    },
  });

  return {
    status: 'error',
    prUrl: input.prUrl,
    costUsd: input.totalCost,
    durationMs: input.maxDuration,
    cyclesCompleted: input.cycle,
    escalated: true,
    escalationReason: input.reason,
    error: message,
  };
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
 * when configured (`review.external.provider`: Bugbot or CodeRabbit).
 */
export async function runCodeReviewLoop(
  params: RunCodeReviewLoopParams,
): Promise<CodeReviewLoopResult> {
  const loopConfig = resolveReviewLoopConfig(params.product);
  // Cross-dispatch seed (ADR-042): a manual re-dispatch resumes the lifetime
  // budget and the no-progress streak instead of restarting them at zero.
  const ledgerSeed = seedFromReviewLoopLedger(params.reviewLoopLedgerEntry);
  let totalCost = 0;
  let maxDuration = 0;
  let cycle = 1;
  /** Remediation passes completed for this lane across every dispatch. */
  let cyclesTotal = ledgerSeed.priorCycles;
  let noProgressStreak = ledgerSeed.noProgressStreak;
  let bestBlockerCount: number | null = ledgerSeed.bestBlockerCount;
  // Separate lanes: internal title fingerprints ≠ external NormalizedFinding.id.
  const internalSticky = createStickyLane();
  const externalSticky = createStickyLane();
  let lastFanout: ReviewerFanoutResult | null = null;
  let ranRemediation = false;
  const falsePositiveCatalog = await fetchFalsePositivesCatalog(
    params.product,
    params.githubToken,
    params.fetchFn,
  );
  // Catalogued adjudications for this stage — the tie-breaker surface the
  // adjudicator and remediator read when reviewers hold opposing blockers.
  const stageCatalogEntries = catalogEntriesForStage(
    falsePositiveCatalog,
    stageForLoopParams(params),
  );
  // Seeded from the enqueue-time snapshot, then re-read at the top of every
  // cycle so an accept posted while this job runs lands on the next pass
  // (ADR-043 §4), the same way settled decisions do.
  let acceptedFindings: StoredAcceptedFinding[] = [...(params.acceptedFindings ?? [])];

  while (true) {
    while (true) {
      acceptedFindings = await resolveAcceptedFindings(params, acceptedFindings);
      const transformReviewComment = await buildFalsePositiveReviewerCommentTransform(
        params,
        falsePositiveCatalog,
        acceptedFindings,
      );
      const fanoutResult = await fanoutReviewers(
        params.externalId,
        params.product,
        params.prUrl,
        params.githubToken,
        params.runtime,
        params.runGit,
        params.runGh,
        {
          fetchFn: params.fetchFn,
          selectedCodeRepo: params.codeRepo,
          selectedBranchName: params.branchName,
          transformReviewComment,
          draftArtifactKind:
            params.mode === 'early-artifact' && params.kind ? params.kind : undefined,
        },
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
        falsePositiveCatalog,
        acceptedFindings,
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
      const currentFindings = collectGateFindings(
        gateFanoutResult.reviewerResults,
        loopConfig.remediateSeverity,
      );
      const currentFingerprints = new Set(currentFindings.map((finding) => finding.fingerprint));
      recordStickyFindings(internalSticky, currentFindings);
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
      // ADR-043 §3 — findings this lane has now seen twice. Empty on cycle 1.
      const stickyFindings = unresolvedStickyFindings(internalSticky, currentFingerprints);

      const stop = evaluateStopRule({
        cycle,
        maxCycles: loopConfig.maxCycles,
        noProgressCycles: loopConfig.noProgressCycles,
        noProgressStreak,
        // The pass this cycle would run is the (cyclesTotal + 1)-th of the
        // item's life; if the rule escalates, it never runs and never counts.
        cumulativeCycle: cyclesTotal + 1,
        maxCyclesCumulative: loopConfig.maxCyclesCumulative,
      });
      if (stop.escalate) {
        return escalateFromStopRule(params, {
          prUrl: fanoutResult.prUrl,
          reason: stop.reason,
          cycle,
          cyclesTotal,
          noProgressStreak,
          bestBlockerCount,
          loopConfig,
          totalCost,
          maxDuration,
        });
      }

      const remediationOutcome = await runRemediationPass({
        ...params,
        fanoutResult: gateFanoutResult,
        totalCost,
        maxDuration,
        catalogEntries: stageCatalogEntries,
        stickyFindings,
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
      cyclesTotal += 1;
      await persistLedgerBestEffort(params, {
        cyclesTotal,
        noProgressStreak,
        bestBlockerCount: bestBlockerCount ?? undefined,
      });
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
        falsePositiveCatalog,
        acceptedFindings,
      );
      if (blockers.length === 0) {
        if (suppressed.length > 0 || external.advisories.length > 0) {
          await postReviewLoopSummaryBestEffort(params, {
            cyclesCompleted: cycle,
            advisories: [...suppressed, ...external.advisories],
            stage: stageForLoopParams(params),
            catalog: falsePositiveCatalog,
            externalProvider: params.product.review?.external?.provider,
            acceptedFindings,
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
      recordStickyFindings(
        externalSticky,
        blockers.map((finding) => ({
          fingerprint: finding.id,
          title: finding.summary,
          severity: finding.severity,
        })),
      );
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
      // External ids and internal fingerprints never share a baseline (ADR-038 §3),
      // so the block handed to the prompts is the external lane's alone.
      const stickyFindings = unresolvedStickyFindings(externalSticky, currentFingerprints);

      const stop = evaluateStopRule({
        cycle,
        maxCycles: loopConfig.maxCycles,
        noProgressCycles: loopConfig.noProgressCycles,
        noProgressStreak,
        cumulativeCycle: cyclesTotal + 1,
        maxCyclesCumulative: loopConfig.maxCyclesCumulative,
      });
      if (stop.escalate) {
        return escalateFromStopRule(params, {
          prUrl: fanout.prUrl,
          reason: stop.reason,
          cycle,
          cyclesTotal,
          noProgressStreak,
          bestBlockerCount,
          loopConfig,
          totalCost,
          maxDuration,
        });
      }

      const remediationOutcome = await runRemediationPass({
        ...params,
        fanoutResult: fanout,
        totalCost,
        maxDuration,
        externalFindingsBody: formatExternalBlockersForRemediation(blockers),
        catalogEntries: stageCatalogEntries,
        stickyFindings,
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
      cyclesTotal += 1;
      await persistLedgerBestEffort(params, {
        cyclesTotal,
        noProgressStreak,
        bestBlockerCount: bestBlockerCount ?? undefined,
      });
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
        stage: stageForLoopParams(params),
        catalog: falsePositiveCatalog,
        externalProvider: params.product.review?.external?.provider,
        acceptedFindings,
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
  catalogEntries?: readonly FalsePositiveEntry[];
  stickyFindings?: readonly StickyFindingRecord[];
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
        catalogEntries: input.catalogEntries,
        stickyFindings: input.stickyFindings,
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
  catalogEntries?: readonly FalsePositiveEntry[];
  stickyFindings?: readonly StickyFindingRecord[];
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
  catalogEntries?: readonly FalsePositiveEntry[];
  stickyFindings?: readonly StickyFindingRecord[];
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
    catalogEntries: input.catalogEntries,
    stickyFindings: input.stickyFindings,
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
      { catalogEntries: input.catalogEntries, stickyFindings: input.stickyFindings },
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
