import { Hono } from 'hono';
import { join } from 'node:path';
import { z } from 'zod';
import { dispatchStageHandler } from '@helm/orchestrator';
import {
  getProductRegistry,
  getItemStore,
  getJobStore,
  getIssueTrackerAdapter,
} from '../services/index.js';
import { createRuntimeForProduct } from '../services/runtime-factory.js';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import type { Job } from '../services/job-store.js';
import type { ItemState } from '../services/types.js';
import type { Product } from '@helm/shared';
import type { ItemStore } from '../services/item-store.js';

export const dispatchRouter = new Hono();

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/);
// Specialists that require operator feedback (early-stage remediators, ADR-024).
const FEEDBACK_REQUIRED_SPECIALISTS = ['spec-remediator', 'plan-remediator'];

const BodySchema = z
  .object({
    specialistId: z.string().min(1).optional(),
    /**
     * Operator feedback for the early-stage remediators. Required (and only
     * meaningful) when specialistId is spec-remediator or plan-remediator.
     */
    feedback: z.string().min(1).max(10000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.specialistId &&
      FEEDBACK_REQUIRED_SPECIALISTS.includes(data.specialistId) &&
      (data.feedback === undefined || data.feedback.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feedback'],
        message: `feedback is required when specialistId is '${data.specialistId}'`,
      });
    }
  });

/**
 * Background function that runs the dispatch job asynchronously.
 * Must never throw — a job must never stay stuck in 'running' status.
 */
async function runDispatchJob(
  job: Job,
  ctx: {
    product: Product;
    item: ItemState;
    store: ItemStore;
    workdir: string;
    dataRoot: string;
    specialistId: string | undefined;
    feedback: string | undefined;
    githubToken: string | undefined;
    fetchTask:
      | ((externalId: string) => Promise<{ title: string; body?: string } | null>)
      | undefined;
  },
): Promise<void> {
  const jobStore = await getJobStore();
  try {
    const runtime = createRuntimeForProduct(ctx.product, ctx.item.externalId, ctx.workdir);
    const result = await dispatchStageHandler(
      {
        externalId: ctx.item.externalId,
        productSlug: ctx.item.productSlug,
        currentStage: ctx.item.currentStage,
      },
      ctx.product,
      runtime,
      (input) => ctx.store.transition(input),
      {
        workdir: ctx.workdir,
        dataRoot: ctx.dataRoot,
        specialistId: ctx.specialistId,
        githubToken: ctx.githubToken,
        fetchTask: ctx.fetchTask,
        feedback: ctx.feedback,
      },
    );

    const now = new Date().toISOString();
    await jobStore.updateJob(job.jobId, {
      // Preserve all three DispatchResult statuses: done, error, cancelled.
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
      console.error('[dispatch] Failed to update job after error:', updateErr);
    }
  }
}

dispatchRouter.post('/products/:slug/items/:externalId/dispatch', async (c) => {
  const slug = c.req.param('slug');
  const externalId = c.req.param('externalId');

  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }
  // Defense-in-depth: EXTERNAL_ID_REGEX already blocks leading dots (via the
  // (?!\.) lookahead), so '.' and '..' fail the regex too. The explicit check
  // below makes the intent clear and guards against future regex relaxations.
  if (!EXTERNAL_ID_REGEX.test(externalId) || externalId === '.' || externalId === '..') {
    return c.json({ error: `Invalid externalId: "${externalId}"` }, 400);
  }

  // Parse JSON body explicitly so malformed JSON returns 400 instead of
  // being silently swallowed as an empty object.
  let parsedBody: unknown = {};
  const rawBody = await c.req.text();
  if (rawBody.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
  }
  const bodyResult = BodySchema.safeParse(parsedBody);
  if (!bodyResult.success) {
    console.error('[dispatch] Invalid request body:', bodyResult.error.issues);
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Resolve product
  let product;
  try {
    const products = await getProductRegistry();
    product = products.find((p) => p.product.slug === slug);
    if (!product) return c.json({ error: `Product not found: ${slug}` }, 404);
  } catch (err) {
    console.error('[dispatch] Failed to load product registry:', err);
    return c.json({ error: 'Failed to load product registry' }, 500);
  }

  // Resolve item
  let store;
  let item;
  try {
    store = await getItemStore();
    item = await store.get(externalId);
  } catch (err) {
    console.error('[dispatch] Failed to load item:', err);
    return c.json({ error: 'Failed to load item' }, 500);
  }
  // Also reject when the item belongs to a different product than the URL slug.
  if (!item || item.productSlug !== slug) {
    return c.json({ error: `Item not found: ${externalId}` }, 404);
  }

  // Determine workdir — sibling of the data/items directory
  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  const dataRoot = envDataDir || join(process.cwd(), 'data');
  const workdir = join(dataRoot, 'worktrees', slug, externalId);

  // Resolve job store and check for concurrency
  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[dispatch] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }

  // Concurrency guard + job creation (atomic check-and-create via in-memory lock).
  const outcome = await jobStore.createJobIfNoRunning({
    productSlug: slug,
    externalId,
    specialistId: bodyResult.data.specialistId ?? 'auto',
  });
  if ('conflict' in outcome) {
    return c.json(
      {
        error: 'A dispatch job is already running for this item',
        runningJobId: outcome.runningJobId,
      },
      409,
    );
  }
  const { job } = outcome;

  // Build fetchTask: best-effort wrapper around the configured issue tracker
  // adapter (GitHub Projects or Linear, based on product.yaml). On any error
  // (adapter init, network, item not found) it returns null so the spec-writer
  // falls back to writing without a ## Task section.
  const fetchTask = async (
    taskExternalId: string,
  ): Promise<{ title: string; body?: string } | null> => {
    try {
      const adapter = await getIssueTrackerAdapter();
      const trackerItem = await adapter.getItem(taskExternalId);
      if (!trackerItem) return null;
      return { title: trackerItem.title, body: trackerItem.body };
    } catch (err) {
      console.error(`[dispatch] fetchTask failed for externalId=${taskExternalId}:`, err);
      return null;
    }
  };

  // Fire and forget — returns 202 immediately
  void runDispatchJob(job, {
    product,
    item,
    store,
    workdir,
    dataRoot,
    specialistId: bodyResult.data.specialistId,
    feedback: bodyResult.data.feedback,
    githubToken: process.env.GITHUB_TOKEN?.trim(),
    fetchTask,
  });

  return c.json({ jobId: job.jobId, status: 'running' }, 202);
});
