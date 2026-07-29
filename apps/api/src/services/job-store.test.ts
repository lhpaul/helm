import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from './job-store.js';

let jobsDir: string;
let store: JobStore;

beforeEach(async () => {
  jobsDir = join(tmpdir(), `helm-jobs-${randomUUID()}`);
  await mkdir(jobsDir, { recursive: true });
  store = new JobStore(jobsDir);
});

afterEach(async () => {
  await rm(jobsDir, { recursive: true, force: true });
});

const BASE_INPUT = {
  productSlug: 'test-product',
  externalId: 'issue_1',
  specialistId: 'spec-writer',
} as const;

describe('createJob', () => {
  it('returns a Job with status running and correct fields', async () => {
    const job = await store.createJob(BASE_INPUT);

    expect(job.status).toBe('running');
    expect(job.productSlug).toBe('test-product');
    expect(job.externalId).toBe('issue_1');
    expect(job.specialistId).toBe('spec-writer');
    expect(typeof job.jobId).toBe('string');
    expect(job.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(typeof job.startedAt).toBe('string');
    expect(job.finishedAt).toBeUndefined();
    expect(job.result).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  it('persists the job to disk', async () => {
    const job = await store.createJob(BASE_INPUT);
    const retrieved = await store.getJob(job.jobId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.jobId).toBe(job.jobId);
    expect(retrieved?.status).toBe('running');
  });

  it('persists targetRevision when provided', async () => {
    const job = await store.createJob({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(job.targetRevision).toBe('sha-a');
    await expect(store.getJob(job.jobId)).resolves.toMatchObject({ targetRevision: 'sha-a' });
  });

  it('each call creates a unique job with a new jobId', async () => {
    const job1 = await store.createJob(BASE_INPUT);
    const job2 = await store.createJob(BASE_INPUT);
    expect(job1.jobId).not.toBe(job2.jobId);
  });
});

describe('getJob', () => {
  it('returns the job for a known jobId', async () => {
    const job = await store.createJob(BASE_INPUT);
    const retrieved = await store.getJob(job.jobId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.jobId).toBe(job.jobId);
  });

  it('returns null for an unknown (but valid) jobId', async () => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const result = await store.getJob(fakeId);
    expect(result).toBeNull();
  });

  it('throws for a malformed jobId', async () => {
    await expect(store.getJob('not-a-uuid')).rejects.toThrow('Invalid jobId');
    await expect(store.getJob('../escape')).rejects.toThrow('Invalid jobId');
    await expect(store.getJob('')).rejects.toThrow('Invalid jobId');
  });
});

describe('updateJob', () => {
  it('merges updates into the existing job and persists', async () => {
    const job = await store.createJob(BASE_INPUT);
    const now = new Date().toISOString();

    const updated = await store.updateJob(job.jobId, {
      status: 'done',
      finishedAt: now,
    });

    expect(updated.status).toBe('done');
    expect(updated.finishedAt).toBe(now);
    // original fields preserved
    expect(updated.jobId).toBe(job.jobId);
    expect(updated.productSlug).toBe('test-product');

    // verify persisted
    const retrieved = await store.getJob(job.jobId);
    expect(retrieved?.status).toBe('done');
    expect(retrieved?.finishedAt).toBe(now);
  });

  it('throws for unknown jobId', async () => {
    const fakeId = '00000000-0000-4000-8000-000000000001';
    await expect(store.updateJob(fakeId, { status: 'done' })).rejects.toThrow('Job not found');
  });
});

describe('listJobsForItem', () => {
  it('returns all jobs for a specific item', async () => {
    const job1 = await store.createJob(BASE_INPUT);
    const job2 = await store.createJob(BASE_INPUT);
    // A job for a different item
    await store.createJob({
      productSlug: 'other-product',
      externalId: 'issue_2',
      specialistId: 'spec-writer',
    });

    const jobs = await store.listJobsForItem('test-product', 'issue_1');
    expect(jobs).toHaveLength(2);
    const ids = jobs.map((j) => j.jobId);
    expect(ids).toContain(job1.jobId);
    expect(ids).toContain(job2.jobId);
  });

  it('returns an empty array for an unknown item', async () => {
    await store.createJob(BASE_INPUT);
    const jobs = await store.listJobsForItem('test-product', 'does-not-exist');
    expect(jobs).toHaveLength(0);
  });

  it('sorts jobs newest first by startedAt', async () => {
    const job1 = await store.createJob(BASE_INPUT);
    // Small delay to ensure different startedAt timestamps
    await new Promise((r) => setTimeout(r, 5));
    const job2 = await store.createJob(BASE_INPUT);

    const jobs = await store.listJobsForItem('test-product', 'issue_1');
    expect(jobs[0]?.jobId).toBe(job2.jobId);
    expect(jobs[1]?.jobId).toBe(job1.jobId);
  });

  it('returns empty array when jobs directory does not exist', async () => {
    await rm(jobsDir, { recursive: true, force: true });
    const freshStore = new JobStore(jobsDir);
    const jobs = await freshStore.listJobsForItem('test-product', 'issue_1');
    expect(jobs).toHaveLength(0);
  });
});

describe('getRunningJobForItem', () => {
  it('returns null when the item has no jobs at all', async () => {
    const running = await store.getRunningJobForItem('test-product', 'issue_1');
    expect(running).toBeNull();
  });

  it('returns null when the item has jobs but none are running', async () => {
    const job = await store.createJob(BASE_INPUT);
    await store.updateJob(job.jobId, { status: 'done', finishedAt: new Date().toISOString() });
    const running = await store.getRunningJobForItem('test-product', 'issue_1');
    expect(running).toBeNull();
  });

  it('returns the running job, ignoring finished jobs for the same item', async () => {
    const done = await store.createJob(BASE_INPUT);
    await store.updateJob(done.jobId, { status: 'done', finishedAt: new Date().toISOString() });
    const errored = await store.createJob(BASE_INPUT);
    await store.updateJob(errored.jobId, { status: 'error', finishedAt: new Date().toISOString() });
    const live = await store.createJob(BASE_INPUT);

    const running = await store.getRunningJobForItem('test-product', 'issue_1');
    expect(running?.jobId).toBe(live.jobId);
    expect(running?.status).toBe('running');
  });

  it('does not match a running job belonging to a different item', async () => {
    await store.createJob({
      productSlug: 'other-product',
      externalId: 'issue_2',
      specialistId: 'spec-writer',
    });
    const running = await store.getRunningJobForItem('test-product', 'issue_1');
    expect(running).toBeNull();
  });
});

describe('createJobIfNoRunning', () => {
  it('creates a job with targetRevision when no running or duplicate job exists', async () => {
    const outcome = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(outcome).toMatchObject({ job: { targetRevision: 'sha-a' } });
  });

  it('dedupes an existing job with the same targetRevision even after it finishes', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');
    await store.updateJob(first.job.jobId, {
      status: 'done',
      finishedAt: new Date().toISOString(),
    });

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(second).toEqual({ duplicate: true, existingJobId: first.job.jobId });
  });

  it('allows retrying the same targetRevision after an error job', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');
    await store.updateJob(first.job.jobId, {
      status: 'error',
      error: 'transient',
      finishedAt: new Date().toISOString(),
    });

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(second).toMatchObject({ job: { targetRevision: 'sha-a' } });
    if (!('job' in second)) throw new Error('expected job');
    expect(second.job.jobId).not.toBe(first.job.jobId);
  });

  it('allows retrying the same targetRevision after a cancelled job', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');
    await store.updateJob(first.job.jobId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    });

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(second).toMatchObject({ job: { targetRevision: 'sha-a' } });
  });

  it('allows retrying the same targetRevision after a deferred job', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');
    await store.updateJob(first.job.jobId, {
      status: 'deferred',
      finishedAt: new Date().toISOString(),
    });

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(second).toMatchObject({ job: { targetRevision: 'sha-a' } });
    if (!('job' in second)) throw new Error('expected job');
    expect(second.job.jobId).not.toBe(first.job.jobId);
  });

  it('blocks a newer targetRevision while an older job is running', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-b' });

    expect(second).toEqual({
      conflict: true,
      runningJobId: first.job.jobId,
      runningTargetRevision: 'sha-a',
    });
  });

  it('allows a newer targetRevision after the older running job finishes', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');
    await store.updateJob(first.job.jobId, {
      status: 'done',
      finishedAt: new Date().toISOString(),
    });

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-b' });

    expect(second).toMatchObject({ job: { targetRevision: 'sha-b' } });
  });

  it('dedupes an existing running job with the same targetRevision', async () => {
    const first = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });
    if (!('job' in first)) throw new Error('expected job');

    const second = await store.createJobIfNoRunning({ ...BASE_INPUT, targetRevision: 'sha-a' });

    expect(second).toEqual({ duplicate: true, existingJobId: first.job.jobId });
    const jobs = await store.listJobsForItem(BASE_INPUT.productSlug, BASE_INPUT.externalId);
    expect(jobs.filter((job) => job.targetRevision === 'sha-a')).toHaveLength(1);
  });
});

describe('reconcileOrphanedJobs', () => {
  it('marks running jobs as error with orphan message', async () => {
    const job = await store.createJob(BASE_INPUT);
    expect(job.status).toBe('running');

    const count = await store.reconcileOrphanedJobs();
    expect(count).toBe(1);

    const updated = await store.getJob(job.jobId);
    expect(updated?.status).toBe('error');
    expect(updated?.error).toBe('orphaned: server restarted during execution');
    expect(updated?.finishedAt).toBeDefined();
  });

  it('skips jobs that are already done or error', async () => {
    const now = new Date().toISOString();
    const doneJob = await store.createJob(BASE_INPUT);
    await store.updateJob(doneJob.jobId, { status: 'done', finishedAt: now });

    const errorJob = await store.createJob(BASE_INPUT);
    await store.updateJob(errorJob.jobId, {
      status: 'error',
      error: 'previous failure',
      finishedAt: now,
    });

    const count = await store.reconcileOrphanedJobs();
    expect(count).toBe(0);

    // verify done job unchanged
    const retrievedDone = await store.getJob(doneJob.jobId);
    expect(retrievedDone?.status).toBe('done');
    expect(retrievedDone?.error).toBeUndefined();
  });

  it('handles multiple running jobs', async () => {
    await store.createJob(BASE_INPUT);
    await store.createJob(BASE_INPUT);
    await store.createJob(BASE_INPUT);

    const count = await store.reconcileOrphanedJobs();
    expect(count).toBe(3);
  });

  it('returns 0 when no jobs exist', async () => {
    const count = await store.reconcileOrphanedJobs();
    expect(count).toBe(0);
  });
});
