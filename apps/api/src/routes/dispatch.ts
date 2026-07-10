import { Hono } from 'hono';
import { join } from 'node:path';
import { z } from 'zod';
import { checkProductReadiness, resolveSpecialistId } from '@helm/orchestrator';
import { getProductRegistry, getItemStore, getJobStore } from '../services/index.js';
import { runDispatchJob } from '../services/dispatch-scheduler.js';
import { validateExternalId } from '../lib/http-errors.js';
import { readGitHubTokenFromEnv } from '../lib/github-token.js';

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

dispatchRouter.post('/products/:slug/items/:externalId/dispatch', async (c) => {
  const slug = c.req.param('slug');

  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }
  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const externalId = idResult.value;

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

  // ── Product-readiness gate (ADR-026) ────────────────────────────────────────
  const gateMode = product.workflow.readiness_gate;
  const resolvedSpecialist = resolveSpecialistId(item.currentStage, bodyResult.data.specialistId);
  if (gateMode !== 'skip' && resolvedSpecialist === 'spec-writer') {
    const githubToken = process.env.GITHUB_TOKEN?.trim();
    try {
      const readiness = await checkProductReadiness(product, githubToken);
      if (!readiness.ready) {
        if (gateMode === 'required') {
          return c.json(
            { error: 'Product not ready for dispatch', missing_context: readiness.missingContext },
            422,
          );
        }
        console.warn(
          `[dispatch] readiness warnings for ${slug}/${externalId}:`,
          JSON.stringify(readiness.missingContext),
        );
      }
    } catch (err) {
      if (gateMode === 'required') {
        console.error('[dispatch] readiness check failed:', err);
        return c.json({ error: 'Readiness check failed' }, 502);
      }
      console.warn('[dispatch] readiness check failed (warn mode, proceeding):', err);
    }
  }

  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  const dataRoot = envDataDir || join(process.cwd(), 'data');
  const workdir = join(dataRoot, 'worktrees', slug, externalId);

  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[dispatch] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }

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

  void runDispatchJob(job, {
    product,
    item,
    workdir,
    dataRoot,
    specialistId: bodyResult.data.specialistId,
    feedback: bodyResult.data.feedback,
    githubToken: readGitHubTokenFromEnv(),
  });

  return c.json({ jobId: job.jobId, status: 'running' }, 202);
});
