import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import { EXTERNAL_ID_REGEX } from './types.js';

export type ReviewDispatchIntentKind = 'review_dispatch' | 'pending_external_review';

export type ReviewDispatchIntent = {
  kind?: ReviewDispatchIntentKind;
  productSlug: string;
  externalId: string;
  specialistId?: string;
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
  specialistId?: string;
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

const REVIEW_DISPATCH_SPECIALIST_SLOTS = [
  undefined,
  'spec-draft-reviewer',
  'plan-draft-reviewer',
] as const;

type ReviewDispatchSpecialistSlot = (typeof REVIEW_DISPATCH_SPECIALIST_SLOTS)[number];

const REVIEW_DISPATCH_FILE_SUFFIX_BY_SPECIALIST: Record<
  Exclude<ReviewDispatchSpecialistSlot, undefined>,
  string
> = {
  'spec-draft-reviewer': '.spec-draft-review',
  'plan-draft-reviewer': '.plan-draft-review',
};

const PENDING_EXTERNAL_REVIEW_FILE_SUFFIX_BY_SPECIALIST: Record<
  Exclude<ReviewDispatchSpecialistSlot, undefined>,
  string
> = {
  'spec-draft-reviewer': '.spec-draft-pending-external-review',
  'plan-draft-reviewer': '.plan-draft-pending-external-review',
};

function isReviewDispatchSpecialistSlot(
  specialistId: string | undefined,
): specialistId is ReviewDispatchSpecialistSlot {
  return REVIEW_DISPATCH_SPECIALIST_SLOTS.includes(specialistId as ReviewDispatchSpecialistSlot);
}

/** Prefer a specialist-scoped slot when sharding leaves duplicate pending rows. */
function pickPendingExternalReviewMatch(
  matches: PendingExternalReviewIntent[],
): PendingExternalReviewIntent | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  const withSpecialist = matches.filter((intent) => typeof intent.specialistId === 'string');
  const pool = withSpecialist.length > 0 ? withSpecialist : matches;
  return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
}

function reviewDispatchFileName(externalId: string, specialistId?: string): string {
  // Draft reviewers share an item but not an outbox slot — keep separate files so a
  // later plan sync cannot clobber a parked spec intent (or vice versa).
  const suffix =
    isReviewDispatchSpecialistSlot(specialistId) && specialistId
      ? REVIEW_DISPATCH_FILE_SUFFIX_BY_SPECIALIST[specialistId]
      : '';
  return `${externalId}${suffix}.json`;
}

function pendingExternalReviewFileName(externalId: string, specialistId?: string): string {
  // External analysis deferrals are per artifact. A spec-draft and plan-draft
  // review can be pending for the same item at the same time.
  const suffix =
    isReviewDispatchSpecialistSlot(specialistId) && specialistId
      ? PENDING_EXTERNAL_REVIEW_FILE_SUFFIX_BY_SPECIALIST[specialistId]
      : '.pending-external-review';
  return `${externalId}${suffix}.json`;
}

export class ReviewDispatchOutbox {
  constructor(private readonly outboxDir: string) {}

  private intentPath(
    productSlug: string,
    externalId: string,
    kind: ReviewDispatchIntentKind = 'review_dispatch',
    specialistId?: string,
  ): string {
    assertSafeIntentKey(productSlug, externalId);
    // Separate files per kind and draft reviewer so concurrent sync + defer,
    // spec-draft, and plan-draft review intents cannot clobber each other.
    const fileName =
      kind === 'pending_external_review'
        ? pendingExternalReviewFileName(externalId, specialistId)
        : reviewDispatchFileName(externalId, specialistId);
    return join(this.outboxDir, productSlug, fileName);
  }

  async put(intent: Omit<ReviewDispatchIntent, 'updatedAt'>): Promise<ReviewDispatchIntent> {
    const kind = normalizeKind(intent.kind);
    const dir = join(this.outboxDir, intent.productSlug);
    assertSafeIntentKey(intent.productSlug, intent.externalId);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const current = await this.get(
      intent.productSlug,
      intent.externalId,
      kind,
      intent.specialistId,
    );
    const sameDeferredRevision =
      kind === 'pending_external_review' &&
      current?.kind === 'pending_external_review' &&
      current.provider === intent.provider &&
      current.prNumber === intent.prNumber &&
      current.targetRevision === intent.targetRevision;
    const stored: ReviewDispatchIntent = {
      ...intent,
      kind,
      // Re-parking without a SHA must not wipe a previously stored revision —
      // otherwise replay exits early with neither schedule nor cleanup.
      targetRevision: intent.targetRevision ?? current?.targetRevision,
      createdAt: sameDeferredRevision ? (current.createdAt ?? now) : (intent.createdAt ?? now),
      updatedAt: now,
    };
    await writeJsonAtomic(
      this.intentPath(intent.productSlug, intent.externalId, kind, intent.specialistId),
      stored,
    );
    return { ...stored };
  }

  async get(
    productSlug: string,
    externalId: string,
    kind: ReviewDispatchIntentKind = 'review_dispatch',
    specialistId?: string,
  ): Promise<ReviewDispatchIntent | null> {
    const intent = await readJson<ReviewDispatchIntent>(
      this.intentPath(productSlug, externalId, kind, specialistId),
    );
    return intent ? { ...intent } : null;
  }

  /** All parked review_dispatch intents for an item (impl + draft specialist slots). */
  async listReviewDispatch(
    productSlug: string,
    externalId: string,
  ): Promise<ReviewDispatchIntent[]> {
    assertSafeIntentKey(productSlug, externalId);
    const intents: ReviewDispatchIntent[] = [];
    for (const specialistId of REVIEW_DISPATCH_SPECIALIST_SLOTS) {
      const intent = await this.get(productSlug, externalId, 'review_dispatch', specialistId);
      if (intent && (intent.kind ?? 'review_dispatch') === 'review_dispatch') {
        intents.push(intent);
      }
    }
    return intents;
  }

  /** All pending external-review intents for an item (impl + draft specialist slots). */
  async listPendingExternalReviews(
    productSlug: string,
    externalId: string,
  ): Promise<PendingExternalReviewIntent[]> {
    assertSafeIntentKey(productSlug, externalId);
    const intents: PendingExternalReviewIntent[] = [];
    for (const specialistId of REVIEW_DISPATCH_SPECIALIST_SLOTS) {
      const intent = await this.get(
        productSlug,
        externalId,
        'pending_external_review',
        specialistId,
      );
      if (
        intent?.kind === 'pending_external_review' &&
        typeof intent.provider === 'string' &&
        intent.reason === 'analysis_pending' &&
        typeof intent.prNumber === 'number' &&
        typeof intent.targetRevision === 'string' &&
        typeof intent.createdAt === 'string' &&
        typeof intent.expiresAt === 'string'
      ) {
        intents.push(intent as PendingExternalReviewIntent);
      }
    }
    return intents;
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
      specialistId?: string;
      provider?: string;
      reason?: 'analysis_pending';
      prNumber?: number;
    },
  ): Promise<boolean> {
    const kind = normalizeKind(expected.kind);
    const current = await this.get(productSlug, externalId, kind, expected.specialistId);
    if (!current) return false;
    if (current.updatedAt !== expected.updatedAt) return false;
    if ((current.targetRevision ?? null) !== (expected.targetRevision ?? null)) return false;
    if (expected.specialistId !== undefined && current.specialistId !== expected.specialistId) {
      return false;
    }
    if (expected.provider !== undefined && current.provider !== expected.provider) return false;
    if (expected.reason !== undefined && current.reason !== expected.reason) return false;
    if (expected.prNumber !== undefined && current.prNumber !== expected.prNumber) return false;
    await unlink(this.intentPath(productSlug, externalId, kind, expected.specialistId)).catch(
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
    specialistId?: string,
  ): Promise<void> {
    await unlink(this.intentPath(productSlug, externalId, kind, specialistId)).catch(
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
      if (!intent.expiresAt || Date.parse(intent.expiresAt) > nowMs) continue;
      const didRemove = await this.removeIfMatches(intent.productSlug, intent.externalId, {
        kind: normalizeKind(intent.kind),
        updatedAt: intent.updatedAt,
        targetRevision: intent.targetRevision,
        specialistId: intent.specialistId,
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
    specialistId?: string;
  }): Promise<PendingExternalReviewIntent | null> {
    const candidates =
      input.specialistId === undefined
        ? await this.listPendingExternalReviews(input.productSlug, input.externalId)
        : await this.findPendingExternalReviewCandidates(
            input.productSlug,
            input.externalId,
            input.specialistId,
          );
    const matches = candidates.filter(
      (intent) =>
        intent.provider === input.provider &&
        intent.reason === 'analysis_pending' &&
        intent.prNumber === input.prNumber &&
        intent.targetRevision === input.targetRevision,
    );
    return pickPendingExternalReviewMatch(matches);
  }

  private async findPendingExternalReviewCandidates(
    productSlug: string,
    externalId: string,
    specialistId: string,
  ): Promise<PendingExternalReviewIntent[]> {
    const specialistIntent = await this.get(
      productSlug,
      externalId,
      'pending_external_review',
      specialistId,
    );
    const shouldCheckLegacy =
      specialistId === 'spec-draft-reviewer' || specialistId === 'plan-draft-reviewer';
    const legacyIntent = shouldCheckLegacy
      ? await this.get(productSlug, externalId, 'pending_external_review')
      : null;
    return [specialistIntent, legacyIntent].filter(
      (intent): intent is PendingExternalReviewIntent =>
        intent?.kind === 'pending_external_review' &&
        typeof intent.createdAt === 'string' &&
        typeof intent.expiresAt === 'string',
    );
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
    return pickPendingExternalReviewMatch(matches);
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
