import { join } from 'node:path';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';
import { dispatchStageHandler, resolveSpecialistId } from '@helm/orchestrator';
import type { Product } from '@helm/shared';
import { createRuntimeForProduct } from './runtime-factory.js';
import { transitionItem } from './item-service.js';
import { getIssueTrackerAdapter, getJobStore, getProductRegistry, getItemStore } from './index.js';
import { readGitHubTokenFromEnv } from '../lib/github-token.js';
import type { Job } from './job-store.js';
import type { ItemState } from './types.js';
import { EXTERNAL_ID_REGEX } from './types.js';

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

    const result = await dispatchStageHandler(
      {
        externalId: ctx.item.externalId,
        productSlug: ctx.item.productSlug,
        currentStage: ctx.item.currentStage,
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
      },
    );

    const now = new Date().toISOString();
    await jobStore.updateJob(job.jobId, {
      status: result.status,
      result,
      finishedAt: now,
    });
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
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  const dataRoot = envDataDir || join(process.cwd(), 'data');
  const workdir = join(dataRoot, 'worktrees', input.productSlug, input.externalId);

  const jobStore = await getJobStore();
  const outcome = await jobStore.createJobIfNoRunning({
    productSlug: input.productSlug,
    externalId: input.externalId,
    specialistId: input.specialistId ?? 'auto',
  });
  if ('conflict' in outcome) {
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
