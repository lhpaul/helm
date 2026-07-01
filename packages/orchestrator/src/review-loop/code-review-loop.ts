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
import { runExternalReviewIfConfigured } from '../external-review/run.js';
import { resolveReviewLoopConfig } from './config.js';
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
};

function escalationMessage(reason: StopRuleEscalationReason, cyclesCompleted: number): string {
  if (reason === 'max_cycles') {
    return `Review loop escalated: reached max_cycles (${cyclesCompleted}) with CRITICAL/HIGH findings still open`;
  }
  return `Review loop escalated: no progress on blocking findings for ${cyclesCompleted} consecutive remediation cycle(s)`;
}

/**
 * Bounded internal fanout ↔ remediate loop (ADR-036), then optional external review
 * when configured (Haystack adapter follows in a subsequent change).
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
  const external = await runExternalReviewIfConfigured(params.product, params.prUrl);
  if (external.status === 'escalate') {
    return {
      status: 'error',
      prUrl: fanout.prUrl,
      costUsd: totalCost,
      durationMs: maxDuration,
      cyclesCompleted: cycle,
      escalated: true,
      error: `External review escalated: ${external.reason}`,
    };
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

  return {
    status: 'done',
    prUrl: fanout.prUrl,
    costUsd: totalCost,
    durationMs: maxDuration,
    cyclesCompleted: cycle,
    newStage: ranRemediation ? 'code-review' : undefined,
  };
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
    for (const r of input.fanoutResult.reviewerResults) {
      if (r.commentBody) {
        findingsByKind.set(r.kind, r.commentBody);
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
