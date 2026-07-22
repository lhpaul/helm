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
} from './review-dispatch-outbox.js';
import { resolveOpenPrMetadata } from './github-pr.js';

const DISPATCH_UNAVAILABLE = 'Unable to schedule dispatch';

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

async function persistPendingReviewDispatch(input: {
  dataRoot: string;
  productSlug: string;
  externalId: string;
  prNumber?: number;
  targetRevision?: string;
  triggeredBy: string;
}): Promise<void> {
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  await outbox.put({
    kind: 'review_dispatch',
    productSlug: input.productSlug,
    externalId: input.externalId,
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
    console.info('[dispatch-scheduler] external review deferral skipped — missing target revision');
    return;
  }
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const now = Date.now();
  await outbox.put({
    kind: 'pending_external_review',
    productSlug: input.intent.productSlug,
    externalId: input.intent.externalId,
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
  });
}

async function finalizePendingExternalReviewResume(
  outbox: Awaited<ReturnType<typeof getReviewDispatchOutbox>>,
  intent: PendingExternalReviewIntent,
  triggeredBy: string,
): Promise<ScheduleItemDispatchResult> {
  if (Date.parse(intent.expiresAt) <= Date.now()) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, {
      kind: 'pending_external_review',
      updatedAt: intent.updatedAt,
      targetRevision: intent.targetRevision,
    });
    return { scheduled: false, reason: 'Pending external review expired' };
  }

  const outcome = await scheduleItemDispatch({
    productSlug: intent.productSlug,
    externalId: intent.externalId,
    specialistId: 'reviewer-fanout',
    targetRevision: intent.targetRevision,
    prNumber: intent.prNumber,
    triggeredBy,
  });
  if (outcome.scheduled || outcome.reason === 'Duplicate target revision') {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, {
      kind: 'pending_external_review',
      updatedAt: intent.updatedAt,
      targetRevision: intent.targetRevision,
    });
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
  if (!input.githubToken) return;
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const intent = await outbox.get(input.productSlug, input.externalId);
  if (!intent) return;
  if ((intent.kind ?? 'review_dispatch') !== 'review_dispatch') return;

  let targetRevision = intent.targetRevision;
  if (intent.prNumber !== undefined) {
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
      return;
    }
    // Prefer the live PR head so replay tracks the newest SHA after headRef validation.
    targetRevision = pr.headSha;
  }
  if (!targetRevision) return;

  const outcome = await scheduleItemDispatch({
    productSlug: intent.productSlug,
    externalId: intent.externalId,
    specialistId: 'reviewer-fanout',
    targetRevision,
    prNumber: intent.prNumber,
    triggeredBy: `outbox:${intent.triggeredBy}`,
  });
  if (outcome.scheduled || outcome.reason === 'Duplicate target revision') {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, {
      updatedAt: intent.updatedAt,
      targetRevision: intent.targetRevision,
    });
  }
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
      if (result.status !== 'deferred') {
        await replayPendingReviewDispatch({
          product: ctx.product,
          productSlug: ctx.item.productSlug,
          externalId: ctx.item.externalId,
          dataRoot: ctx.dataRoot,
          githubToken: ctx.githubToken,
        });
      }
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

  const resolvedSpecialist = resolveSpecialistId(item.currentStage, input.specialistId);
  if (!resolvedSpecialist) {
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
    specialistId: input.specialistId ?? 'auto',
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
    if (
      input.targetRevision &&
      outcome.runningTargetRevision !== undefined &&
      outcome.runningTargetRevision !== input.targetRevision
    ) {
      await persistPendingReviewDispatch({
        dataRoot,
        productSlug: input.productSlug,
        externalId: input.externalId,
        prNumber: input.prNumber,
        targetRevision: input.targetRevision,
        triggeredBy: input.triggeredBy,
      });
    } else if (input.targetRevision && outcome.runningTargetRevision === undefined) {
      await persistPendingReviewDispatch({
        dataRoot,
        productSlug: input.productSlug,
        externalId: input.externalId,
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
    `[dispatch-scheduler] ${input.triggeredBy} → job ${outcome.job.jobId} for ${input.productSlug}/${input.externalId} (${resolvedSpecialist})`,
  );

  void runDispatchJob(outcome.job, {
    product,
    item,
    workdir,
    dataRoot,
    specialistId: resolvedSpecialist,
    feedback: undefined,
    githubToken,
  }).catch((err) => {
    logErrorMetadata('dispatch-scheduler runDispatchJob', err);
  });

  return { scheduled: true, jobId: outcome.job.jobId };
}
