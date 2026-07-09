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

function logErrorMessage(scope: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${scope}] ${message}`);
}

export type ScheduleItemDispatchResult =
  | { scheduled: true; jobId: string }
  | { scheduled: false; reason: string; runningJobId?: string };

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
        logErrorMessage('dispatch fetchTask', err);
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
      logErrorMessage('dispatch job update', updateErr);
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
  const products = await getProductRegistry();
  const product = products.find((p) => p.product.slug === input.productSlug);
  if (!product) {
    return { scheduled: false, reason: 'Product not found' };
  }

  const store = await getItemStore();
  const item = await store.get(input.externalId);
  if (!item || item.productSlug !== input.productSlug) {
    return { scheduled: false, reason: 'Item not found' };
  }

  const resolvedSpecialist = resolveSpecialistId(item.currentStage, input.specialistId);
  if (!resolvedSpecialist) {
    return {
      scheduled: false,
      reason: 'No specialist mapped for the current stage',
    };
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
    return {
      scheduled: false,
      reason: 'A dispatch job is already running for this item',
      runningJobId: outcome.runningJobId,
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
    specialistId: input.specialistId,
    feedback: undefined,
    githubToken: readGitHubTokenFromEnv(),
  }).catch((err) => {
    logErrorMessage('dispatch-scheduler runDispatchJob', err);
  });

  return { scheduled: true, jobId: outcome.job.jobId };
}
