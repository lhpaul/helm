import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import { EXTERNAL_ID_REGEX } from './types.js';

export type ReviewDispatchIntent = {
  productSlug: string;
  externalId: string;
  prNumber?: number;
  targetRevision?: string;
  triggeredBy: string;
  updatedAt: string;
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
    return join(this.outboxDir, `${productSlug}--${externalId}.json`);
  }

  async put(intent: Omit<ReviewDispatchIntent, 'updatedAt'>): Promise<ReviewDispatchIntent> {
    const stored: ReviewDispatchIntent = { ...intent, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.intentPath(intent.productSlug, intent.externalId), stored);
    return { ...stored };
  }

  async get(productSlug: string, externalId: string): Promise<ReviewDispatchIntent | null> {
    const intent = await readJson<ReviewDispatchIntent>(this.intentPath(productSlug, externalId));
    return intent ? { ...intent } : null;
  }

  async remove(productSlug: string, externalId: string): Promise<void> {
    await unlink(this.intentPath(productSlug, externalId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async list(): Promise<ReviewDispatchIntent[]> {
    let entries: string[];
    try {
      entries = await readdir(this.outboxDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const intents = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => readJson<ReviewDispatchIntent>(join(this.outboxDir, entry))),
    );
    return intents.filter((intent): intent is ReviewDispatchIntent => intent !== null);
  }
}

export async function getReviewDispatchOutbox(dataRoot: string): Promise<ReviewDispatchOutbox> {
  const outboxDir = join(dataRoot, 'review-dispatch-outbox');
  await mkdir(outboxDir, { recursive: true });
  return new ReviewDispatchOutbox(outboxDir);
}
