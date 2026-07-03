import { rm } from 'node:fs/promises';
import type { CodeRepo, Product } from '@helm/shared';
import type { IAgentRuntime } from '../runtime.js';
import type { ItemTransitionFn } from '../specialists/spec-writer.js';
import {
  fanoutReviewers,
  shouldRemediate,
  type ReviewerFanoutResult,
  type ReviewerKind,
} from '../specialists/reviewer-fanout.js';
import { buildRemediationParams, handleRemediationResult } from '../specialists/remediation.js';
import { provisionReviewerWorkspace, artifactsDirFor } from '../specialists/code-workspace.js';
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
import type { FetchFn } from '../specialists/fetch-product-context.js';
import { resolveReviewLoopConfig } from './config.js';
import { formatReviewLoopEscalationComment } from './escalation-comment.js';
import { evaluateExternalReviewStopRule } from './external-stop-rule.js';
import { fetchFalsePositivesCatalog } from './false-positives.js';
import { upsertReviewLoopSummaryComment } from './summary.js';
import {
  countBlockingFindings,
  evaluateStopRule,
  nextNoProgressStreak,
  type StopRuleEscalationReason,
} from './stop-rule.js';

export type CodeReviewLoopResult = {
  status: 'done' | 'error';
  prUrl: string;
  costUsd: number;
  durationMs: number;
  cyclesCompleted: number;
  newStage?: 'code-review' | 'remediation';
  error?: string;
  escalated?: boolean;
  escalationReason?: StopRuleEscalationReason;
};

export type RunCodeReviewLoopParams = {
  externalId: string;
  product: Product;
  prUrl: string;
  codeRepo: CodeRepo;
  githubToken: string;
  runtime: IAgentRuntime;
  transition: ItemTransitionFn;
  runGit?: RunGit;
  runGh?: RunGh;
  externalReviewDeps?: RunExternalReviewDeps;
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: FetchFn;
};

function escalationMessage(reason: StopRuleEscalationReason, cyclesCompleted: number): string {
  if (reason === 'max_cycles') {
    return `Review loop escalated: reached max_cycles (${cyclesCompleted}) with CRITICAL/HIGH findings still open`;
  }
  if (reason === 'no_progress') {
    return `Review loop escalated: no progress on blocking findings for ${cyclesCompleted} consecutive remediation cycle(s)`;
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
      runGh: params.runGh,
    });
  } catch {
    // Best-effort — clean loop exit is still valid without the summary comment.
  }
}

type ExternalReviewLoopOutcome =
  | { kind: 'continue'; external: ExternalReviewResult }
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
  let priorBlockerCount: number | null = null;
  let lastFanout: ReviewerFanoutResult | null = null;
  let ranRemediation = false;

  while (true) {
    while (true) {
      const fanoutResult = await fanoutReviewers(
        params.externalId,
        params.product,
        params.prUrl,
        params.githubToken,
        params.runtime,
        params.runGit,
        params.runGh,
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

      if (!shouldRemediate(fanoutResult.reviewerResults)) {
        break;
      }

      const blockerCount = countBlockingFindings(fanoutResult.reviewerResults);
      noProgressStreak = nextNoProgressStreak(priorBlockerCount, blockerCount, noProgressStreak);
      priorBlockerCount = blockerCount;

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
          error: escalationMessage(stop.reason, cycle),
        };
      }

      const remediationOutcome = await runRemediationPass({
        ...params,
        fanoutResult,
        totalCost,
        maxDuration,
      });
      ranRemediation = true;
      totalCost = remediationOutcome.totalCost;
      maxDuration = remediationOutcome.maxDuration;

      if (remediationOutcome.status === 'error') {
        return {
          status: 'error',
          prUrl: fanoutResult.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          newStage: remediationOutcome.newStage,
          error: remediationOutcome.error,
        };
      }

      cycle += 1;
    }

    const fanout = lastFanout!;
    const externalOutcome = await runExternalReviewWithStopRule(params, loopConfig);
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
      const blockerCount = external.blockers.length;
      noProgressStreak = nextNoProgressStreak(priorBlockerCount, blockerCount, noProgressStreak);
      priorBlockerCount = blockerCount;

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
          error: escalationMessage(stop.reason, cycle),
        };
      }

      const remediationOutcome = await runRemediationPass({
        ...params,
        fanoutResult: fanout,
        totalCost,
        maxDuration,
        externalFindingsBody: formatExternalBlockersForRemediation(external.blockers),
      });
      ranRemediation = true;
      totalCost = remediationOutcome.totalCost;
      maxDuration = remediationOutcome.maxDuration;

      if (remediationOutcome.status === 'error') {
        return {
          status: 'error',
          prUrl: fanout.prUrl,
          costUsd: totalCost,
          durationMs: maxDuration,
          cyclesCompleted: cycle,
          newStage: remediationOutcome.newStage,
          error: remediationOutcome.error,
        };
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
        externalProvider: params.product.review?.external?.provider,
      });
    }

    return {
      status: 'done',
      prUrl: fanout.prUrl,
      costUsd: totalCost,
      durationMs: maxDuration,
      cyclesCompleted: cycle,
      newStage: ranRemediation ? 'code-review' : undefined,
    };
  }
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

async function runRemediationPass(input: {
  externalId: string;
  product: Product;
  prUrl: string;
  codeRepo: CodeRepo;
  githubToken: string;
  runtime: IAgentRuntime;
  transition: ItemTransitionFn;
  runGit?: RunGit;
  runGh?: RunGh;
  fanoutResult: ReviewerFanoutResult;
  totalCost: number;
  maxDuration: number;
  externalFindingsBody?: string;
}): Promise<RemediationPassOutcome> {
  let remediationWorkspace = '';
  try {
    const provisioned = await provisionReviewerWorkspace(
      {
        externalId: input.externalId,
        codeRepo: input.codeRepo,
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
      newStage: 'code-review',
      error: `Failed to provision remediation workspace: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    try {
      await input.transition({
        externalId: input.externalId,
        toStage: 'remediation',
        triggeredBy: 'specialist:remediation',
      });
    } catch (err) {
      return {
        status: 'error',
        totalCost: input.totalCost,
        maxDuration: input.maxDuration,
        newStage: 'code-review',
        error: `Failed to transition to remediation: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const findingsByKind = new Map<ReviewerKind, string>();
    if (input.externalFindingsBody) {
      findingsByKind.set(
        'code',
        ['## External review blockers', '', input.externalFindingsBody].join('\n'),
      );
    } else {
      for (const r of input.fanoutResult.reviewerResults) {
        if (r.commentBody) {
          findingsByKind.set(r.kind, r.commentBody);
        }
      }
    }

    const params = buildRemediationParams(
      input.externalId,
      input.product,
      remediationWorkspace,
      input.prUrl,
      findingsByKind,
    );
    const session = await input.runtime.spawn(params);
    const agentResult = await session.wait();

    const remediationResult = await handleRemediationResult(
      input.externalId,
      agentResult,
      remediationWorkspace,
      input.prUrl,
      input.githubToken,
      input.codeRepo,
      input.runGit,
      input.runGh,
    );

    const totalCost = input.totalCost + remediationResult.costUsd;
    const maxDuration = Math.max(input.maxDuration, remediationResult.durationMs);

    if (remediationResult.status !== 'done') {
      return {
        status: 'error',
        totalCost,
        maxDuration,
        newStage: 'remediation',
        error: remediationResult.error,
      };
    }

    try {
      await input.transition({
        externalId: input.externalId,
        toStage: 'code-review',
        triggeredBy: 'specialist:remediation',
      });
    } catch (err) {
      return {
        status: 'error',
        totalCost,
        maxDuration,
        newStage: 'remediation',
        error: `Failed to transition back to code-review: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (input.fanoutResult.status === 'error') {
      return {
        status: 'error',
        totalCost,
        maxDuration,
        newStage: 'code-review',
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
