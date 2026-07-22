import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import { EXTERNAL_ID_REGEX } from './types.js';

export type ReviewDispatchIntent = {
  kind?: 'review_dispatch' | 'pending_external_review';
  productSlug: string;
  externalId: string;
  prNumber?: number;
  targetRevision?: string;
  provider?: string;
  reason?: 'analysis_pending';
  createdAt?: string;
  expiresAt?: string;
  triggeredBy: string;
  updatedAt: string;
};

export type PendingExternalReviewIntent = ReviewDispatchIntent & {
  kind: 'pending_external_review';
  provider: string;
  reason: 'analysis_pending';
  prNumber: number;
  targetRevision: string;
  createdAt: string;
  expiresAt: string;
};

function isSafeSegment(value: string): boolean {
  return EXTERNAL_ID_REGEX.test(value) && value !== '.' && value !== '..';
}

function assertSafeIntentKey(productSlug: string, externalId: string): void {
  if (!isSafeSegment(productSlug) || !isSafeSegment(externalId)) {
    throw new Error('Unsafe review dispatch intent key');
  }
}

export class ReviewDispatchOutbox {
  constructor(private readonly outboxDir: string) {}

  private intentPath(productSlug: string, externalId: string): string {
    assertSafeIntentKey(productSlug, externalId);
    // Nested path avoids `${slug}--${id}` collisions when either segment contains `--`.
    return join(this.outboxDir, productSlug, `${externalId}.json`);
  }

  async put(intent: Omit<ReviewDispatchIntent, 'updatedAt'>): Promise<ReviewDispatchIntent> {
    const dir = join(this.outboxDir, intent.productSlug);
    assertSafeIntentKey(intent.productSlug, intent.externalId);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const current = await this.get(intent.productSlug, intent.externalId);
    const sameDeferredRevision =
      intent.kind === 'pending_external_review' &&
      current?.kind === 'pending_external_review' &&
      current.provider === intent.provider &&
      current.prNumber === intent.prNumber &&
      current.targetRevision === intent.targetRevision;
    const stored: ReviewDispatchIntent = {
      ...intent,
      createdAt: sameDeferredRevision ? (current.createdAt ?? now) : (intent.createdAt ?? now),
      updatedAt: now,
    };
    await writeJsonAtomic(this.intentPath(intent.productSlug, intent.externalId), stored);
    return { ...stored };
  }

  async get(productSlug: string, externalId: string): Promise<ReviewDispatchIntent | null> {
    const intent = await readJson<ReviewDispatchIntent>(this.intentPath(productSlug, externalId));
    return intent ? { ...intent } : null;
  }

  /**
   * Removes an intent only when the stored identity still matches `expected`.
   * Prevents a concurrent newer put from being deleted by a stale replay.
   */
  async removeIfMatches(
    productSlug: string,
    externalId: string,
    expected: Pick<ReviewDispatchIntent, 'updatedAt' | 'targetRevision'>,
  ): Promise<boolean> {
    const current = await this.get(productSlug, externalId);
    if (!current) return false;
    if (current.updatedAt !== expected.updatedAt) return false;
    if ((current.targetRevision ?? null) !== (expected.targetRevision ?? null)) return false;
    await unlink(this.intentPath(productSlug, externalId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return true;
  }

  async remove(productSlug: string, externalId: string): Promise<void> {
    await unlink(this.intentPath(productSlug, externalId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async findPendingExternalReview(input: {
    productSlug: string;
    externalId: string;
    provider: string;
    prNumber: number;
    targetRevision: string;
  }): Promise<PendingExternalReviewIntent | null> {
    const intent = await this.get(input.productSlug, input.externalId);
    if (!intent) return null;
    if (intent.kind !== 'pending_external_review') return null;
    if (intent.provider !== input.provider) return null;
    if (intent.reason !== 'analysis_pending') return null;
    if (intent.prNumber !== input.prNumber) return null;
    if (intent.targetRevision !== input.targetRevision) return null;
    if (!intent.createdAt || !intent.expiresAt) return null;
    return intent as PendingExternalReviewIntent;
  }

  async list(): Promise<ReviewDispatchIntent[]> {
    let productDirs: string[];
    try {
      productDirs = await readdir(this.outboxDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const intents: ReviewDispatchIntent[] = [];
    for (const productSlug of productDirs) {
      if (!isSafeSegment(productSlug)) continue;
      let entries: string[];
      try {
        entries = await readdir(join(this.outboxDir, productSlug));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const intent = await readJson<ReviewDispatchIntent>(
          join(this.outboxDir, productSlug, entry),
        );
        if (intent) intents.push({ ...intent });
      }
    }
    return intents;
  }
}

export async function getReviewDispatchOutbox(dataRoot: string): Promise<ReviewDispatchOutbox> {
  const outboxDir = join(dataRoot, 'review-dispatch-outbox');
  await mkdir(outboxDir, { recursive: true });
  return new ReviewDispatchOutbox(outboxDir);
}
