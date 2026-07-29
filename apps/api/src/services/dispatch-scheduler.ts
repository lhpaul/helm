import { join } from 'node:path';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';
import {
  dispatchStageHandler,
  resolveSpecialistId,
  type DeferredExternalReviewIntent,
} from '@helm/orchestrator';
import type { Product } from '@helm/shared';
import { createRuntimeForProduct } from './runtime-factory.js';
import { transitionItem } from './item-service.js';
import { getIssueTrackerAdapter, getJobStore, getProductRegistry, getItemStore } from './index.js';
import { readGitHubTokenFromEnv } from '../lib/github-token.js';
import type { Job } from './job-store.js';
import type { ItemState } from './types.js';
import { EXTERNAL_ID_REGEX } from './types.js';
import {
  getReviewDispatchOutbox,
  type PendingExternalReviewIntent,
  type ReviewDispatchIntent,
} from './review-dispatch-outbox.js';
import {
  parseGitHubRepoUrl,
  resolveOpenPrMetadata,
  resolveOpenPrMetadataForRepo,
} from './github-pr.js';
import { createGitHubBugbotReviewLoader } from './bugbot-review-loader.js';

const DISPATCH_UNAVAILABLE = 'Unable to schedule dispatch';
const DRAFT_REVIEWER_NO_LONGER_APPLICABLE = 'Draft reviewer no longer applicable';
/** Parked early-loop intents may be replayed before the item reaches draft stage. */
const DRAFT_REVIEWER_NOT_YET_APPLICABLE = 'Draft reviewer not yet applicable';

/** Coarse stage rank so we can tell "awaiting draft" from "past draft". */
const STAGE_RANK: Record<string, number> = {
  discovery: 0,
  'spec-draft': 10,
  'spec-ready': 20,
  'plan-draft': 30,
  'plan-ready': 40,
  'in-development': 50,
  'code-review': 60,
  remediation: 65,
  merged: 70,
  released: 80,
};

function draftReviewerSkipReason(input: {
  earlyLoopEnabled: boolean;
  itemStage: string;
  draftStage: 'spec-draft' | 'plan-draft';
}): typeof DRAFT_REVIEWER_NO_LONGER_APPLICABLE | typeof DRAFT_REVIEWER_NOT_YET_APPLICABLE | null {
  if (!input.earlyLoopEnabled) return DRAFT_REVIEWER_NO_LONGER_APPLICABLE;
  if (input.itemStage === input.draftStage) return null;
  const itemRank = STAGE_RANK[input.itemStage] ?? Number.POSITIVE_INFINITY;
  const draftRank = STAGE_RANK[input.draftStage] ?? 0;
  // Unknown stages are treated as past-draft so we clear rather than strand forever.
  if (itemRank < draftRank) return DRAFT_REVIEWER_NOT_YET_APPLICABLE;
  return DRAFT_REVIEWER_NO_LONGER_APPLICABLE;
}

function isSafeWorkdirSegment(value: string): boolean {
  return EXTERNAL_ID_REGEX.test(value) && value !== '.' && value !== '..';
}

function logErrorMetadata(scope: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'Error';
  const code =
    err !== null && typeof err === 'object' && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : 'none';
  console.error(`[${scope}] errorType=${name} errorCode=${code}`);
}

export type ScheduleItemDispatchResult =
  | { scheduled: true; jobId: string }
  | { scheduled: false; reason: string };

function dataRootFromEnv(): string {
  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  return envDataDir || join(process.cwd(), 'data');
}

function parseGitHubPrNumber(prUrl: string | undefined): number | null {
  const match = prUrl?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function inferEarlyLoopDraftReviewer(
  product: Product,
  item: ItemState,
): 'spec-draft-reviewer' | 'plan-draft-reviewer' | undefined {
  if (product.review?.early_loop?.enabled !== true) return undefined;
  if (item.currentStage === 'spec-draft') return 'spec-draft-reviewer';
  if (item.currentStage === 'plan-draft') return 'plan-draft-reviewer';
  return undefined;
}

function draftReviewerFromTriggeredBy(
  triggeredBy: string | undefined,
): 'spec-draft-reviewer' | 'plan-draft-reviewer' | undefined {
  if (!triggeredBy) return undefined;
  if (triggeredBy.includes('spec-pr-sync') || triggeredBy.includes('awaiting-spec-draft')) {
    return 'spec-draft-reviewer';
  }
  if (triggeredBy.includes('plan-pr-sync') || triggeredBy.includes('awaiting-plan-draft')) {
    return 'plan-draft-reviewer';
  }
  return undefined;
}

function looksLikeImplReviewTrigger(triggeredBy: string | undefined): boolean {
  if (!triggeredBy) return false;
  return (
    triggeredBy.includes('impl-pr-sync') ||
    triggeredBy.includes('pr-decision-comment') ||
    triggeredBy.includes('implementer') ||
    triggeredBy.includes('reviewer-fanout')
  );
}

function isDraftReviewSpecialist(
  specialistId: string | undefined,
): specialistId is 'spec-draft-reviewer' | 'plan-draft-reviewer' {
  return specialistId === 'spec-draft-reviewer' || specialistId === 'plan-draft-reviewer';
}

function isTerminalPullRequestLookupError(err: unknown): boolean {
  return err instanceof Error && err.message === 'Pull request is not open';
}

async function inferPendingReviewSpecialist(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
}): Promise<string | undefined> {
  if (input.specialistId) return input.specialistId;

  const [products, store] = await Promise.all([getProductRegistry(), getItemStore()]);
  const product = products.find((p) => p.product.slug === input.productSlug);
  if (!product) return undefined;
  const item = await store.get(input.externalId);
  if (!item || item.productSlug !== input.productSlug) return undefined;
  return inferEarlyLoopDraftReviewer(product, item);
}

async function resolveReviewDispatchReplaySpecialist(intent: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  triggeredBy?: string;
}): Promise<string> {
  if (intent.specialistId) return intent.specialistId;

  const fromTrigger = draftReviewerFromTriggeredBy(intent.triggeredBy);
  if (fromTrigger) return fromTrigger;
  if (looksLikeImplReviewTrigger(intent.triggeredBy)) return 'reviewer-fanout';

  return (
    (await inferPendingReviewSpecialist(intent).catch((err) => {
      logErrorMetadata('dispatch pending replay specialist inference', err);
      return undefined;
    })) ?? 'reviewer-fanout'
  );
}

async function persistPendingReviewDispatch(input: {
  dataRoot: string;
  productSlug: string;
  externalId: string;
  specialistId?: string;
  prNumber?: number;
  targetRevision?: string;
  triggeredBy: string;
}): Promise<void> {
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  await outbox.put({
    kind: 'review_dispatch',
    productSlug: input.productSlug,
    externalId: input.externalId,
    specialistId: input.specialistId,
    prNumber: input.prNumber,
    targetRevision: input.targetRevision,
    triggeredBy: input.triggeredBy,
  });
}

async function persistPendingExternalReview(input: {
  dataRoot: string;
  intent: DeferredExternalReviewIntent;
  triggeredBy: string;
}): Promise<void> {
  if (!input.intent.targetRevision) {
    throw new Error('Cannot persist pending external review without target revision');
  }
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const now = Date.now();
  await outbox.put({
    kind: 'pending_external_review',
    productSlug: input.intent.productSlug,
    externalId: input.intent.externalId,
    specialistId: input.intent.specialistId,
    prNumber: input.intent.prNumber,
    targetRevision: input.intent.targetRevision,
    provider: input.intent.provider,
    reason: input.intent.reason,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.intent.maxDeferSec * 1000).toISOString(),
    triggeredBy: input.triggeredBy,
  });
}

/** Exported for webhook handlers that must durable-store before ACK. */
export async function persistReviewDispatchIntent(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  prNumber?: number;
  targetRevision?: string;
  triggeredBy: string;
}): Promise<void> {
  await persistPendingReviewDispatch({
    dataRoot: dataRootFromEnv(),
    ...input,
  });
}

export async function resumePendingExternalReview(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  provider: string;
  prNumber: number;
  targetRevision: string;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  const intent = await outbox.findPendingExternalReview(input);
  if (!intent) {
    return { scheduled: false, reason: 'No matching pending external review' };
  }
  return finalizePendingExternalReviewResume(outbox, intent, input.triggeredBy);
}

/** Look up a pending intent by SHA without scheduling (for webhook preconditions). */
export async function peekPendingExternalReviewByRevision(input: {
  productSlug: string;
  provider: string;
  targetRevision: string;
}): Promise<PendingExternalReviewIntent | null> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  return outbox.findPendingExternalReviewByRevision(input);
}

/** Resume when readiness has a SHA but no PR metadata (empty check_run.pull_requests). */
export async function resumePendingExternalReviewByRevision(input: {
  productSlug: string;
  provider: string;
  targetRevision: string;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult & { externalId?: string }> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  const intent = await outbox.findPendingExternalReviewByRevision(input);
  if (!intent) {
    return { scheduled: false, reason: 'No matching pending external review' };
  }
  const outcome = await finalizePendingExternalReviewResume(outbox, intent, input.triggeredBy);
  return { ...outcome, externalId: intent.externalId };
}

export async function clearPendingExternalReview(input: {
  productSlug: string;
  externalId?: string;
  specialistId?: string;
  provider: string;
  prNumber?: number;
  targetRevision: string;
}): Promise<boolean> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  const intent =
    input.externalId !== undefined && input.prNumber !== undefined
      ? await outbox.findPendingExternalReview({
          productSlug: input.productSlug,
          externalId: input.externalId,
          specialistId: input.specialistId,
          provider: input.provider,
          prNumber: input.prNumber,
          targetRevision: input.targetRevision,
        })
      : await outbox.findPendingExternalReviewByRevision({
          productSlug: input.productSlug,
          provider: input.provider,
          targetRevision: input.targetRevision,
        });
  if (!intent) return false;
  if (input.externalId !== undefined && intent.externalId !== input.externalId) return false;
  if (input.prNumber !== undefined && intent.prNumber !== input.prNumber) return false;
  return outbox.removeIfMatches(intent.productSlug, intent.externalId, {
    kind: 'pending_external_review',
    updatedAt: intent.updatedAt,
    targetRevision: intent.targetRevision,
    specialistId: intent.specialistId,
    provider: intent.provider,
    reason: intent.reason,
    prNumber: intent.prNumber,
  });
}

/** Minimum gap between opportunistic expiry sweeps on the dispatch hot path. */
const PENDING_EXTERNAL_SWEEP_MIN_INTERVAL_MS = 60_000;
let lastPendingExternalSweepAt = 0;

export async function sweepExpiredPendingExternalReviews(): Promise<number> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  return outbox.removeExpiredPendingExternalReviews();
}

async function maybeSweepExpiredPendingExternalReviews(): Promise<void> {
  const now = Date.now();
  if (now - lastPendingExternalSweepAt < PENDING_EXTERNAL_SWEEP_MIN_INTERVAL_MS) return;
  lastPendingExternalSweepAt = now;
  await sweepExpiredPendingExternalReviews();
}

async function finalizePendingExternalReviewResume(
  outbox: Awaited<ReturnType<typeof getReviewDispatchOutbox>>,
  intent: PendingExternalReviewIntent,
  triggeredBy: string,
): Promise<ScheduleItemDispatchResult> {
  const pendingIntentMatch = {
    kind: 'pending_external_review' as const,
    updatedAt: intent.updatedAt,
    targetRevision: intent.targetRevision,
    specialistId: intent.specialistId,
    provider: intent.provider,
    reason: intent.reason,
    prNumber: intent.prNumber,
  };

  if (Date.parse(intent.expiresAt) <= Date.now()) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return { scheduled: false, reason: 'Pending external review expired' };
  }

  const specialistId = await inferPendingReviewSpecialist(intent);
  const outcome = await scheduleItemDispatch({
    productSlug: intent.productSlug,
    externalId: intent.externalId,
    specialistId,
    targetRevision: intent.targetRevision,
    prNumber: intent.prNumber,
    triggeredBy,
  });
  if (outcome.scheduled || outcome.reason === 'Duplicate target revision') {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return outcome;
  }
  if (outcome.reason === DRAFT_REVIEWER_NO_LONGER_APPLICABLE) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return outcome;
  }

  // Draft external readiness arrived before the item reached the matching
  // draft stage. Re-park a review_dispatch intent so the next stage-transition
  // replay can resume instead of leaving the pending_external_review stranded
  // until expiry.
  if (outcome.reason === DRAFT_REVIEWER_NOT_YET_APPLICABLE) {
    await persistPendingReviewDispatch({
      dataRoot: dataRootFromEnv(),
      productSlug: intent.productSlug,
      externalId: intent.externalId,
      specialistId,
      prNumber: intent.prNumber,
      targetRevision: intent.targetRevision,
      triggeredBy: `${triggeredBy}:awaiting-draft-stage`,
    });
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return {
      scheduled: false,
      reason: 'Draft reviewer not yet applicable — queued review dispatch for stage transition',
    };
  }

  // Readiness arrived while another job is still running (often the deferred
  // job exiting). Park a review_dispatch intent so the post-job replay path
  // schedules fanout after the conflict clears — do not drop the signal.
  if (outcome.reason === DISPATCH_UNAVAILABLE) {
    await persistPendingReviewDispatch({
      dataRoot: dataRootFromEnv(),
      productSlug: intent.productSlug,
      externalId: intent.externalId,
      specialistId,
      prNumber: intent.prNumber,
      targetRevision: intent.targetRevision,
      triggeredBy: `${triggeredBy}:awaiting-job-exit`,
    });
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return {
      scheduled: false,
      reason: 'Job already running — queued review dispatch for replay after exit',
    };
  }

  return outcome;
}

async function replayPendingReviewDispatch(input: {
  product: Product;
  productSlug: string;
  externalId: string;
  dataRoot: string;
  githubToken: string | undefined;
}): Promise<void> {
  const githubToken = input.githubToken;
  if (!githubToken) return;
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const intents = await outbox.listReviewDispatch(input.productSlug, input.externalId);
  for (const intent of intents) {
    try {
      await replayOnePendingReviewDispatch({ ...input, githubToken, outbox, intent });
    } catch (err) {
      logErrorMetadata('dispatch pending replay intent', err);
    }
  }
}

async function replayOnePendingReviewDispatch(input: {
  product: Product;
  productSlug: string;
  externalId: string;
  dataRoot: string;
  githubToken: string;
  outbox: Awaited<ReturnType<typeof getReviewDispatchOutbox>>;
  intent: ReviewDispatchIntent;
}): Promise<void> {
  const { intent, outbox } = input;
  if ((intent.kind ?? 'review_dispatch') !== 'review_dispatch') return;

  const removeIntent = () =>
    outbox.removeIfMatches(intent.productSlug, intent.externalId, {
      updatedAt: intent.updatedAt,
      targetRevision: intent.targetRevision,
      specialistId: intent.specialistId,
    });
  const reparkDraftIntent = async (updatedTargetRevision: string) => {
    if (!isDraftReviewSpecialist(replaySpecialist)) return;
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: intent.productSlug,
      externalId: intent.externalId,
      specialistId: replaySpecialist,
      prNumber: intent.prNumber,
      targetRevision: updatedTargetRevision,
      triggeredBy: `outbox:${intent.triggeredBy}:awaiting-draft-stage`,
    });
    await removeIntent();
  };
  const handleReplayOutcome = async (
    outcome: ScheduleItemDispatchResult,
    updatedTargetRevision: string,
  ) => {
    if (
      outcome.scheduled ||
      outcome.reason === 'Duplicate target revision' ||
      outcome.reason === DRAFT_REVIEWER_NO_LONGER_APPLICABLE
    ) {
      await removeIntent();
      return;
    }
    if (outcome.reason === DRAFT_REVIEWER_NOT_YET_APPLICABLE) {
      await reparkDraftIntent(updatedTargetRevision);
    }
  };

  let targetRevision = intent.targetRevision;
  const replaySpecialist = await resolveReviewDispatchReplaySpecialist(intent);
  if (
    isDraftReviewSpecialist(replaySpecialist) &&
    input.product.review?.early_loop?.enabled !== true
  ) {
    console.info(
      `[dispatch-scheduler] pending replay skipped — ${replaySpecialist} requires review.early_loop.enabled=true`,
    );
    await removeIntent();
    return;
  }
  if (intent.prNumber !== undefined) {
    if (replaySpecialist !== 'reviewer-fanout') {
      const artifactKind =
        replaySpecialist === 'spec-draft-reviewer'
          ? 'spec'
          : replaySpecialist === 'plan-draft-reviewer'
            ? 'plan'
            : undefined;
      if (artifactKind) {
        let pr: Awaited<ReturnType<typeof resolveOpenPrMetadataForRepo>>;
        try {
          pr = await resolveOpenPrMetadataForRepo({
            repo: parseGitHubRepoUrl(input.product.knowledge_repo.url),
            prNumber: intent.prNumber,
            githubToken: input.githubToken,
          });
        } catch (err) {
          if (isTerminalPullRequestLookupError(err)) {
            console.info(
              `[dispatch-scheduler] pending replay skipped — artifact PR #${intent.prNumber} is no longer open`,
            );
            await removeIntent();
            return;
          }
          throw err;
        }
        const expectedHeadRef = `helm/${artifactKind}/${intent.externalId}`;
        if (pr.headRef !== expectedHeadRef) {
          // Never reuse a knowledge-repo PR number against the code repo.
          // Impl intents without a specialistId are routed to reviewer-fanout
          // before this draft branch via looksLikeImplReviewTrigger.
          console.info(
            `[dispatch-scheduler] pending replay skipped — headRef '${pr.headRef}' !== '${expectedHeadRef}'`,
          );
          await removeIntent();
          return;
        }
        targetRevision = pr.headSha;
        if (!targetRevision) return;
        const outcome = await scheduleItemDispatch({
          productSlug: intent.productSlug,
          externalId: intent.externalId,
          specialistId: replaySpecialist,
          targetRevision,
          prNumber: intent.prNumber,
          triggeredBy: `outbox:${intent.triggeredBy}`,
        });
        await handleReplayOutcome(outcome, targetRevision);
        return;
      } else {
        if (!targetRevision) return;
        const outcome = await scheduleItemDispatch({
          productSlug: intent.productSlug,
          externalId: intent.externalId,
          specialistId: replaySpecialist,
          targetRevision,
          prNumber: intent.prNumber,
          triggeredBy: `outbox:${intent.triggeredBy}`,
        });
        await handleReplayOutcome(outcome, targetRevision);
        return;
      }
    }
    if (replaySpecialist === 'reviewer-fanout') {
      const pr = await resolveOpenPrMetadata({
        product: input.product,
        prNumber: intent.prNumber,
        githubToken: input.githubToken,
      });
      const expectedHeadRef = `helm/impl/${intent.externalId}`;
      if (pr.headRef !== expectedHeadRef) {
        console.info(
          `[dispatch-scheduler] pending replay skipped — headRef '${pr.headRef}' !== '${expectedHeadRef}'`,
        );
        await removeIntent();
        return;
      }
      // Prefer the live PR head so replay tracks the newest SHA after headRef validation.
      targetRevision = pr.headSha;
    }
  }
  if (!targetRevision) return;

  const outcome = await scheduleItemDispatch({
    productSlug: intent.productSlug,
    externalId: intent.externalId,
    specialistId: replaySpecialist,
    targetRevision,
    prNumber: intent.prNumber,
    triggeredBy: `outbox:${intent.triggeredBy}`,
  });
  await handleReplayOutcome(outcome, targetRevision);
}

/** Replay a parked review dispatch after an external state transition. */
export async function replayPendingReviewDispatchForItem(input: {
  product: Product;
  productSlug: string;
  externalId: string;
}): Promise<void> {
  await replayPendingReviewDispatch({
    product: input.product,
    productSlug: input.productSlug,
    externalId: input.externalId,
    dataRoot: dataRootFromEnv(),
    githubToken: readGitHubTokenFromEnv(),
  });
}

async function scheduleReviewAfterImplementerCompletion(input: {
  product: Product;
  item: ItemState;
  dataRoot: string;
  prUrl: string | undefined;
  githubToken: string | undefined;
}): Promise<void> {
  const prNumber = parseGitHubPrNumber(input.prUrl);
  if (!input.githubToken) {
    await persistPendingReviewDispatch({
      dataRoot: input.dataRoot,
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      prNumber: prNumber ?? undefined,
      triggeredBy: 'agent:implementer:missing-token',
    });
    return;
  }
  if (prNumber === null) {
    await persistPendingReviewDispatch({
      dataRoot: input.dataRoot,
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      triggeredBy: 'agent:implementer:missing-pr-url',
    });
    return;
  }

  try {
    const pr = await resolveOpenPrMetadata({
      product: input.product,
      prNumber,
      githubToken: input.githubToken,
    });
    const expectedHeadRef = `helm/impl/${input.item.externalId}`;
    if (pr.headRef !== expectedHeadRef) {
      await persistPendingReviewDispatch({
        dataRoot: input.dataRoot,
        productSlug: input.item.productSlug,
        externalId: input.item.externalId,
        specialistId: 'reviewer-fanout',
        prNumber,
        triggeredBy: 'agent:implementer:head-ref-mismatch',
      });
      return;
    }
    const outcome = await scheduleItemDispatch({
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      targetRevision: pr.headSha,
      prNumber,
      triggeredBy: 'agent:implementer:code-review',
    });
    if (!outcome.scheduled && outcome.reason !== 'Duplicate target revision') {
      await persistPendingReviewDispatch({
        dataRoot: input.dataRoot,
        productSlug: input.item.productSlug,
        externalId: input.item.externalId,
        specialistId: 'reviewer-fanout',
        prNumber,
        targetRevision: pr.headSha,
        triggeredBy: 'agent:implementer:code-review',
      });
    }
  } catch {
    await persistPendingReviewDispatch({
      dataRoot: input.dataRoot,
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      prNumber,
      triggeredBy: 'agent:implementer:lookup-failed',
    });
  }
}

/**
 * Runs a dispatch job asynchronously. Must never throw — a job must never stay
 * stuck in 'running' status.
 */
export async function runDispatchJob(
  job: Job,
  ctx: {
    product: Product;
    item: ItemState;
    workdir: string;
    dataRoot: string;
    specialistId: string | undefined;
    feedback: string | undefined;
    githubToken: string | undefined;
  },
): Promise<void> {
  const jobStore = await getJobStore();
  try {
    const runtime = createRuntimeForProduct(ctx.product, ctx.item.externalId, ctx.workdir);
    const fetchTask = async (
      taskExternalId: string,
    ): Promise<{ title: string; body?: string } | null> => {
      try {
        const adapter = await getIssueTrackerAdapter();
        const trackerItem = await adapter.getItem(taskExternalId);
        if (!trackerItem) return null;
        return { title: trackerItem.title, body: trackerItem.body };
      } catch (err) {
        if (err instanceof GitHubNotFoundError || err instanceof LinearNotFoundError) {
          return null;
        }
        logErrorMetadata('dispatch fetchTask', err);
        throw err;
      }
    };

    // Re-read item state so decisions recorded after enqueue are visible in this run.
    const store = await getItemStore();
    const freshItem = (await store.get(ctx.item.externalId)) ?? ctx.item;

    const result = await dispatchStageHandler(
      {
        externalId: freshItem.externalId,
        productSlug: freshItem.productSlug,
        currentStage: freshItem.currentStage,
      },
      ctx.product,
      runtime,
      transitionItem,
      {
        workdir: ctx.workdir,
        dataRoot: ctx.dataRoot,
        specialistId: ctx.specialistId,
        githubToken: ctx.githubToken,
        fetchTask,
        feedback: ctx.feedback,
        resolvedProductDecisions: [...(freshItem.resolvedProductDecisions ?? [])],
        loadResolvedProductDecisions: async () => {
          const latest = await store.get(freshItem.externalId);
          if (latest === null) {
            throw new Error(
              `Item not found while reloading settled decisions: ${freshItem.externalId}`,
            );
          }
          return [...(latest.resolvedProductDecisions ?? [])];
        },
        targetRevision: job.targetRevision,
        onExternalReviewDeferred: async (intent) => {
          await persistPendingExternalReview({
            dataRoot: ctx.dataRoot,
            intent,
            triggeredBy: 'external-review:analysis-pending',
          });
        },
        externalReviewDeps:
          ctx.product.review?.external?.provider === 'bugbot' && ctx.githubToken
            ? {
                loadBugbotReview: createGitHubBugbotReviewLoader({
                  product: ctx.product,
                  githubToken: ctx.githubToken,
                }),
              }
            : undefined,
      },
    );

    const now = new Date().toISOString();
    await jobStore.updateJob(job.jobId, {
      status: result.status,
      result,
      finishedAt: now,
    });
    try {
      if (
        result.status === 'done' &&
        result.newStage === 'code-review' &&
        ctx.specialistId === 'implementer'
      ) {
        await scheduleReviewAfterImplementerCompletion({
          product: ctx.product,
          item: { ...ctx.item, currentStage: 'code-review' },
          dataRoot: ctx.dataRoot,
          prUrl: result.prUrl,
          githubToken: ctx.githubToken,
        });
      }
      // Always replay parked review_dispatch intents — including after a
      // deferred external-review job — so readiness that raced the exit is not lost.
      await replayPendingReviewDispatch({
        product: ctx.product,
        productSlug: ctx.item.productSlug,
        externalId: ctx.item.externalId,
        dataRoot: ctx.dataRoot,
        githubToken: ctx.githubToken,
      });
    } catch (handoffErr) {
      logErrorMetadata('dispatch review handoff', handoffErr);
    }
  } catch (err) {
    const now = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    try {
      await jobStore.updateJob(job.jobId, {
        status: 'error',
        error: message,
        finishedAt: now,
      });
    } catch (updateErr) {
      logErrorMetadata('dispatch job update', updateErr);
    }
    try {
      await replayPendingReviewDispatch({
        product: ctx.product,
        productSlug: ctx.item.productSlug,
        externalId: ctx.item.externalId,
        dataRoot: ctx.dataRoot,
        githubToken: ctx.githubToken,
      });
    } catch (replayErr) {
      logErrorMetadata('dispatch pending replay', replayErr);
    }
  }
}

/**
 * Enqueues a background dispatch when preconditions are met. Used by webhook
 * re-dispatch on impl PR synchronize (item must be in `code-review`).
 */
export async function scheduleItemDispatch(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  targetRevision?: string;
  prNumber?: number;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult> {
  if (!isSafeWorkdirSegment(input.externalId) || !isSafeWorkdirSegment(input.productSlug)) {
    console.info('[dispatch-scheduler] skip: unsafe path segment in dispatch request');
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  await maybeSweepExpiredPendingExternalReviews();

  const products = await getProductRegistry();
  const product = products.find((p) => p.product.slug === input.productSlug);
  if (!product) {
    console.info(`[dispatch-scheduler] skip: product not found (${input.productSlug})`);
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const store = await getItemStore();
  const item = await store.get(input.externalId);
  if (!item || item.productSlug !== input.productSlug) {
    console.info(
      `[dispatch-scheduler] skip: item not found (${input.productSlug}/${input.externalId})`,
    );
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const requestedSpecialist = input.specialistId ?? inferEarlyLoopDraftReviewer(product, item);
  const resolvedSpecialist = resolveSpecialistId(item.currentStage, requestedSpecialist);
  const dispatchSpecialist = resolvedSpecialist ?? requestedSpecialist;
  const draftReviewerStage =
    dispatchSpecialist === 'spec-draft-reviewer'
      ? 'spec-draft'
      : dispatchSpecialist === 'plan-draft-reviewer'
        ? 'plan-draft'
        : undefined;
  if (draftReviewerStage) {
    const skipReason = draftReviewerSkipReason({
      earlyLoopEnabled: product.review?.early_loop?.enabled === true,
      itemStage: item.currentStage,
      draftStage: draftReviewerStage,
    });
    if (skipReason) {
      console.info(
        `[dispatch-scheduler] skip: ${dispatchSpecialist} ${skipReason} (stage '${item.currentStage}', need '${draftReviewerStage}') (${input.productSlug}/${input.externalId})`,
      );
      return {
        scheduled: false,
        reason: skipReason,
      };
    }
  }
  if (!dispatchSpecialist) {
    console.info(
      `[dispatch-scheduler] skip: no specialist for stage '${item.currentStage}' (${input.productSlug}/${input.externalId})`,
    );
    return {
      scheduled: false,
      reason: DISPATCH_UNAVAILABLE,
    };
  }

  const githubToken = readGitHubTokenFromEnv();
  if (!githubToken) {
    console.error('[dispatch-scheduler] GITHUB_TOKEN is not configured — dispatch skipped');
    if (input.targetRevision || input.prNumber !== undefined) {
      try {
        await persistPendingReviewDispatch({
          dataRoot: dataRootFromEnv(),
          productSlug: input.productSlug,
          externalId: input.externalId,
          specialistId: dispatchSpecialist,
          prNumber: input.prNumber,
          targetRevision: input.targetRevision,
          triggeredBy: input.triggeredBy,
        });
      } catch (err) {
        logErrorMetadata('dispatch-scheduler persist pending (no token)', err);
      }
    }
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const dataRoot = dataRootFromEnv();
  const workdir = join(dataRoot, 'worktrees', input.productSlug, input.externalId);

  const jobStore = await getJobStore();
  const outcome = await jobStore.createJobIfNoRunning({
    productSlug: input.productSlug,
    externalId: input.externalId,
    specialistId: dispatchSpecialist,
    targetRevision: input.targetRevision,
  });
  if ('duplicate' in outcome) {
    console.info(
      `[dispatch-scheduler] dispatch skipped — target revision already scheduled (${outcome.existingJobId})`,
    );
    return {
      scheduled: false,
      reason: 'Duplicate target revision',
    };
  }
  if ('conflict' in outcome) {
    if (input.targetRevision || input.prNumber !== undefined) {
      await persistPendingReviewDispatch({
        dataRoot,
        productSlug: input.productSlug,
        externalId: input.externalId,
        specialistId: dispatchSpecialist,
        prNumber: input.prNumber,
        targetRevision: input.targetRevision,
        triggeredBy: input.triggeredBy,
      });
    }
    console.info(
      `[dispatch-scheduler] dispatch skipped — job already running (${outcome.runningJobId})`,
    );
    return {
      scheduled: false,
      reason: DISPATCH_UNAVAILABLE,
    };
  }

  console.info(
    `[dispatch-scheduler] ${input.triggeredBy} → job ${outcome.job.jobId} for ${input.productSlug}/${input.externalId} (${dispatchSpecialist})`,
  );

  void runDispatchJob(outcome.job, {
    product,
    item,
    workdir,
    dataRoot,
    specialistId: dispatchSpecialist,
    feedback: undefined,
    githubToken,
  }).catch((err) => {
    logErrorMetadata('dispatch-scheduler runDispatchJob', err);
  });

  return { scheduled: true, jobId: outcome.job.jobId };
}
