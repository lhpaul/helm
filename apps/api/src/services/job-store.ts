import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
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
  targetRevision?: string;
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
   * In-memory lock keys (`productSlug:externalId`) held while a job is being
   * created. Prevents TOCTOU races in single-process Bun: the `has` check is
   * synchronous so two concurrent callers cannot both pass it before `add`.
   */
  private readonly _inflightKeys = new Set<string>();

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
   * Uses writeFile with flag 'wx' (exclusive create) so a colliding jobId
   * (astronomically unlikely with UUID v4) throws EEXIST rather than silently
   * overwriting an existing record.
   */
  async createJob(input: {
    productSlug: string;
    externalId: string;
    specialistId: string;
    targetRevision?: string;
  }): Promise<Job> {
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: Job = {
      jobId,
      productSlug: input.productSlug,
      externalId: input.externalId,
      specialistId: input.specialistId,
      status: 'running',
      ...(input.targetRevision ? { targetRevision: input.targetRevision } : {}),
      startedAt: now,
    };
    await mkdir(this.jobsDir, { recursive: true });
    await writeFile(this.jobPath(jobId), JSON.stringify(job, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
    });
    return { ...job };
  }

  /**
   * Atomically checks for a running job and, if none exists, creates a new one.
   * An in-memory lock prevents TOCTOU races in single-process Bun: the `has`
   * check is synchronous so two concurrent callers cannot both pass before `add`.
   *
   * Returns `{ job }` on success or `{ conflict: true, runningJobId }` if a
   * running job already exists for the item.
   */
  async createJobIfNoRunning(input: {
    productSlug: string;
    externalId: string;
    specialistId: string;
    targetRevision?: string;
  }): Promise<
    | { job: Job }
    | { duplicate: true; existingJobId: string }
    | { conflict: true; runningJobId: string; runningTargetRevision?: string }
  > {
    const lockKey = `${input.productSlug}:${input.externalId}`;

    // Synchronous check-and-set — safe in single-threaded Bun event loop.
    if (this._inflightKeys.has(lockKey)) {
      // Another request is mid-creation for this item. Return 409 immediately;
      // the running jobId will be visible on disk within one event-loop tick.
      const jobs = await this.listJobsForItem(input.productSlug, input.externalId);
      const running = jobs.find((j) => j.status === 'running');
      return {
        conflict: true,
        runningJobId: running?.jobId ?? '',
        runningTargetRevision: running?.targetRevision,
      };
    }

    this._inflightKeys.add(lockKey);
    try {
      const jobs = await this.listJobsForItem(input.productSlug, input.externalId);
      if (input.targetRevision) {
        // Permanent dedupe only for in-flight or successfully completed work.
        // error/cancelled revisions must remain retryable after transient failures.
        const duplicate = jobs.find(
          (j) =>
            j.targetRevision === input.targetRevision &&
            (j.status === 'running' || j.status === 'done'),
        );
        if (duplicate) return { duplicate: true, existingJobId: duplicate.jobId };
      }
      const running = jobs.find((j) => j.status === 'running');
      if (running) {
        return {
          conflict: true,
          runningJobId: running.jobId,
          runningTargetRevision: running.targetRevision,
        };
      }
      const job = await this.createJob(input);
      return { job };
    } finally {
      this._inflightKeys.delete(lockKey);
    }
  }

  /**
   * Returns a job by jobId, or null if not found.
   * Throws for malformed jobIds.
   */
  async getJob(jobId: string): Promise<Job | null> {
    const job = await readJson<Job>(this.jobPath(jobId));
    return job ? { ...job } : null;
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
    return { ...updated };
  }

  /**
   * Lists all jobs for a given product item, sorted newest first.
   * Returns an empty array if no jobs match.
   * Filenames are validated against JOB_ID_REGEX before path construction
   * to reject any non-UUID entries written outside the store.
   */
  async listJobsForItem(productSlug: string, externalId: string): Promise<Job[]> {
    let entries: string[];
    try {
      entries = await readdir(this.jobsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    // Only process files whose stem is a valid UUID v4 — rejects dotfiles,
    // temp files, and any entry that could produce an unsafe path.
    const jobFiles = entries.filter((f) => {
      if (!f.endsWith('.json')) return false;
      const stem = f.slice(0, -5); // strip '.json'
      return JOB_ID_REGEX.test(stem);
    });

    const results = await Promise.all(jobFiles.map((f) => readJson<Job>(join(this.jobsDir, f))));

    return results
      .filter(
        (j): j is Job => j !== null && j.productSlug === productSlug && j.externalId === externalId,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((j) => ({ ...j }));
  }

  /**
   * Returns the running job for an item, or null if none is running.
   *
   * Thin read-only wrapper over listJobsForItem for callers that need a
   * concurrency guard WITHOUT creating a job (e.g. the rollback endpoint, which
   * must refuse to move an item while a dispatch is in flight). Job creation
   * with the atomic in-memory lock stays in createJobIfNoRunning.
   */
  async getRunningJobForItem(productSlug: string, externalId: string): Promise<Job | null> {
    const jobs = await this.listJobsForItem(productSlug, externalId);
    return jobs.find((j) => j.status === 'running') ?? null;
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

    const jobFiles = entries.filter((f) => {
      if (!f.endsWith('.json')) return false;
      const stem = f.slice(0, -5);
      return JOB_ID_REGEX.test(stem);
    });

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
