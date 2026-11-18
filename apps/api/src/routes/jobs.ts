import { Hono } from 'hono';
import { z } from 'zod';
import { getJobStore } from '../services/index.js';
import { validateExternalId, validateJobId } from '../lib/http-errors.js';

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
  const idResult = validateJobId(c.req.param('jobId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const jobId = idResult.value;

  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[jobs] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }

  let job;
  try {
    job = await jobStore.getJob(jobId);
  } catch (err) {
    console.error('[jobs] Failed to read job:', err);
    return c.json({ error: 'Failed to read job' }, 500);
  }

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

  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }

  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const externalId = idResult.value;

  let jobStore;
  try {
    jobStore = await getJobStore();
  } catch (err) {
    console.error('[jobs] Failed to load job store:', err);
    return c.json({ error: 'Failed to load job store' }, 500);
  }

  let jobs;
  try {
    jobs = await jobStore.listJobsForItem(slug, externalId);
  } catch (err) {
    console.error('[jobs] Failed to list jobs:', err);
    return c.json({ error: 'Failed to list jobs' }, 500);
  }

  return c.json(
    jobs.map((j) => ({ ...j })),
    200,
  );
});
