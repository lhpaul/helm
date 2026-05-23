import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import type { DispatchResult } from '@helm/orchestrator';

// JOB_ID_REGEX: matches Node crypto.randomUUID() output (UUID v4)
export const JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Job = {
  jobId: string;
  productSlug: string;
  externalId: string;
  specialistId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: DispatchResult;
  error?: string;
};

/**
 * File-based persistence for async dispatch jobs.
 * Each job is stored as data/jobs/{jobId}.json using atomic writes.
 * Jobs are flat — not nested by item — to allow direct lookup by jobId.
 */
export class JobStore {
  constructor(private readonly jobsDir: string) {}

  /**
   * Validates that a jobId matches UUID v4 format.
   * Throws on invalid jobId to prevent path traversal attacks.
   */
  private jobPath(jobId: string): string {
    if (!JOB_ID_REGEX.test(jobId)) {
      throw new Error(`Invalid jobId: "${jobId}". Must be a valid UUID v4.`);
    }
    return join(this.jobsDir, `${jobId}.json`);
  }

  /**
   * Creates a new job record with status 'running'.
   */
  async createJob(input: {
    productSlug: string;
    externalId: string;
    specialistId: string;
  }): Promise<Job> {
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: Job = {
      jobId,
      productSlug: input.productSlug,
      externalId: input.externalId,
      specialistId: input.specialistId,
      status: 'running',
      startedAt: now,
    };
    await writeJsonAtomic(this.jobPath(jobId), job);
    return job;
  }

  /**
   * Returns a job by jobId, or null if not found.
   * Throws for malformed jobIds.
   */
  async getJob(jobId: string): Promise<Job | null> {
    return readJson<Job>(this.jobPath(jobId));
  }

  /**
   * Merges updates into an existing job and persists.
   * Throws if the job does not exist.
   */
  async updateJob(jobId: string, updates: Partial<Omit<Job, 'jobId'>>): Promise<Job> {
    const existing = await readJson<Job>(this.jobPath(jobId));
    if (existing === null) {
      throw new Error(`Job not found: "${jobId}"`);
    }
    const updated: Job = { ...existing, ...updates };
    await writeJsonAtomic(this.jobPath(jobId), updated);
    return updated;
  }

  /**
   * Lists all jobs for a given product item, sorted newest first.
   * Returns an empty array if no jobs match.
   */
  async listJobsForItem(productSlug: string, externalId: string): Promise<Job[]> {
    let entries: string[];
    try {
      entries = await readdir(this.jobsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const jobFiles = entries.filter((f) => f.endsWith('.json') && !f.startsWith('.'));

    const results = await Promise.all(jobFiles.map((f) => readJson<Job>(join(this.jobsDir, f))));

    return results
      .filter(
        (j): j is Job => j !== null && j.productSlug === productSlug && j.externalId === externalId,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Marks all running jobs as error with an orphan message.
   * Called on server startup to clean up jobs that were interrupted.
   * Returns the count of reconciled jobs.
   */
  async reconcileOrphanedJobs(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.jobsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    const jobFiles = entries.filter((f) => f.endsWith('.json') && !f.startsWith('.'));

    const jobs = await Promise.all(jobFiles.map((f) => readJson<Job>(join(this.jobsDir, f))));

    const runningJobs = jobs.filter((j): j is Job => j !== null && j.status === 'running');

    const now = new Date().toISOString();
    await Promise.all(
      runningJobs.map((job) =>
        this.updateJob(job.jobId, {
          status: 'error',
          error: 'orphaned: server restarted during execution',
          finishedAt: now,
        }),
      ),
    );

    return runningJobs.length;
  }
}
