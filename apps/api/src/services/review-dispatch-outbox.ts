import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import { EXTERNAL_ID_REGEX } from './types.js';

export type ReviewDispatchIntentKind = 'review_dispatch' | 'pending_external_review';

export type ReviewDispatchIntent = {
  kind?: ReviewDispatchIntentKind;
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

function normalizeKind(kind: ReviewDispatchIntentKind | undefined): ReviewDispatchIntentKind {
  return kind ?? 'review_dispatch';
}

export class ReviewDispatchOutbox {
  constructor(private readonly outboxDir: string) {}

  private intentPath(
    productSlug: string,
    externalId: string,
    kind: ReviewDispatchIntentKind = 'review_dispatch',
  ): string {
    assertSafeIntentKey(productSlug, externalId);
    // Separate files per kind so review_dispatch and pending_external_review
    // cannot clobber each other under concurrent sync + defer.
    const fileName =
      kind === 'pending_external_review'
        ? `${externalId}.pending-external-review.json`
        : `${externalId}.json`;
    return join(this.outboxDir, productSlug, fileName);
  }

  async put(intent: Omit<ReviewDispatchIntent, 'updatedAt'>): Promise<ReviewDispatchIntent> {
    const kind = normalizeKind(intent.kind);
    const dir = join(this.outboxDir, intent.productSlug);
    assertSafeIntentKey(intent.productSlug, intent.externalId);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const current = await this.get(intent.productSlug, intent.externalId, kind);
    const sameDeferredRevision =
      kind === 'pending_external_review' &&
      current?.kind === 'pending_external_review' &&
      current.provider === intent.provider &&
      current.prNumber === intent.prNumber &&
      current.targetRevision === intent.targetRevision;
    const stored: ReviewDispatchIntent = {
      ...intent,
      kind,
      createdAt: sameDeferredRevision ? (current.createdAt ?? now) : (intent.createdAt ?? now),
      updatedAt: now,
    };
    await writeJsonAtomic(this.intentPath(intent.productSlug, intent.externalId, kind), stored);
    return { ...stored };
  }

  async get(
    productSlug: string,
    externalId: string,
    kind: ReviewDispatchIntentKind = 'review_dispatch',
  ): Promise<ReviewDispatchIntent | null> {
    const intent = await readJson<ReviewDispatchIntent>(
      this.intentPath(productSlug, externalId, kind),
    );
    return intent ? { ...intent } : null;
  }

  /**
   * Removes an intent only when the stored identity still matches `expected`.
   * Prevents a concurrent newer put from being deleted by a stale replay.
   */
  async removeIfMatches(
    productSlug: string,
    externalId: string,
    expected: Pick<ReviewDispatchIntent, 'updatedAt' | 'targetRevision'> & {
      kind?: ReviewDispatchIntentKind;
      provider?: string;
      reason?: 'analysis_pending';
      prNumber?: number;
    },
  ): Promise<boolean> {
    const kind = normalizeKind(expected.kind);
    const current = await this.get(productSlug, externalId, kind);
    if (!current) return false;
    if (current.updatedAt !== expected.updatedAt) return false;
    if ((current.targetRevision ?? null) !== (expected.targetRevision ?? null)) return false;
    if (expected.provider !== undefined && current.provider !== expected.provider) return false;
    if (expected.reason !== undefined && current.reason !== expected.reason) return false;
    if (expected.prNumber !== undefined && current.prNumber !== expected.prNumber) return false;
    await unlink(this.intentPath(productSlug, externalId, kind)).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      },
    );
    return true;
  }

  async remove(
    productSlug: string,
    externalId: string,
    kind: ReviewDispatchIntentKind = 'review_dispatch',
  ): Promise<void> {
    await unlink(this.intentPath(productSlug, externalId, kind)).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      },
    );
  }

  async removeExpiredPendingExternalReviews(now = new Date()): Promise<number> {
    const nowMs = now.getTime();
    const intents = await this.list();
    let removed = 0;
    for (const intent of intents) {
      if (intent.kind !== 'pending_external_review') continue;
      if (!intent.expiresAt || Date.parse(intent.expiresAt) > nowMs) continue;
      const didRemove = await this.removeIfMatches(intent.productSlug, intent.externalId, {
        kind: 'pending_external_review',
        updatedAt: intent.updatedAt,
        targetRevision: intent.targetRevision,
        provider: intent.provider,
        reason: intent.reason,
        prNumber: intent.prNumber,
      });
      if (didRemove) removed += 1;
    }
    return removed;
  }

  async findPendingExternalReview(input: {
    productSlug: string;
    externalId: string;
    provider: string;
    prNumber: number;
    targetRevision: string;
  }): Promise<PendingExternalReviewIntent | null> {
    const intent = await this.get(input.productSlug, input.externalId, 'pending_external_review');
    if (!intent) return null;
    if (intent.kind !== 'pending_external_review') return null;
    if (intent.provider !== input.provider) return null;
    if (intent.reason !== 'analysis_pending') return null;
    if (intent.prNumber !== input.prNumber) return null;
    if (intent.targetRevision !== input.targetRevision) return null;
    if (!intent.createdAt || !intent.expiresAt) return null;
    return intent as PendingExternalReviewIntent;
  }

  /**
   * Match a readiness signal that lacks PR metadata (common for check_run
   * payloads with an empty `pull_requests` array) by exact revision + provider.
   */
  async findPendingExternalReviewByRevision(input: {
    productSlug: string;
    provider: string;
    targetRevision: string;
  }): Promise<PendingExternalReviewIntent | null> {
    const intents = await this.list();
    const matches = intents.filter(
      (intent): intent is PendingExternalReviewIntent =>
        intent.kind === 'pending_external_review' &&
        intent.productSlug === input.productSlug &&
        intent.provider === input.provider &&
        intent.reason === 'analysis_pending' &&
        intent.targetRevision === input.targetRevision &&
        typeof intent.prNumber === 'number' &&
        typeof intent.createdAt === 'string' &&
        typeof intent.expiresAt === 'string',
    );
    return matches.length === 1 ? matches[0]! : null;
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
