import { Hono } from 'hono';
import { z } from 'zod';
import { getJobStore } from '../services/index.js';
import { JOB_ID_REGEX } from '../services/job-store.js';
import { EXTERNAL_ID_REGEX } from '../services/types.js';

export const jobsRouter = new Hono();

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/);

/**
 * GET /api/jobs/:jobId
 * Returns the job record for the given jobId.
 */
jobsRouter.get('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  if (!JOB_ID_REGEX.test(jobId)) {
    return c.json({ error: `Invalid jobId: "${jobId}"` }, 400);
  }

  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[jobs] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }

  const job = await jobStore.getJob(jobId);
  if (!job) {
    return c.json({ error: `Job not found: ${jobId}` }, 404);
  }

  return c.json({ ...job }, 200);
});

/**
 * GET /api/products/:slug/items/:externalId/jobs
 * Returns all jobs for the given item, sorted newest first.
 */
jobsRouter.get('/products/:slug/items/:externalId/jobs', async (c) => {
  const slug = c.req.param('slug');
  const externalId = c.req.param('externalId');

  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }

  if (!EXTERNAL_ID_REGEX.test(externalId) || externalId === '.' || externalId === '..') {
    return c.json({ error: `Invalid externalId: "${externalId}"` }, 400);
  }

  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[jobs] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }

  const jobs = await jobStore.listJobsForItem(slug, externalId);
  return c.json(
    jobs.map((j) => ({ ...j })),
    200,
  );
});
