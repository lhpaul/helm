import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidExternalId } from '@helm/shared';
import { readJson, writeJsonAtomic } from '@helm/storage';

/**
 * A readiness signal that reached Helm before any pending external-review
 * intent existed for its revision (#135, TD-002).
 *
 * The provider starts on a push, and Helm cannot write an intent for a
 * revision before that revision exists. A fast provider can therefore deliver
 * `external_review_ready` while the loop is still running its internal fan-out.
 * Instead of dropping that signal, the webhook records it here; the review loop
 * consumes it when it defers on the same revision, and drops it when its own
 * poll sees completion.
 *
 * Stored apart from the review-dispatch outbox so the outbox format, readers
 * and expiry sweep stay unchanged.
 */
export type ExternalReviewReadinessNote = {
  productSlug: string;
  provider: string;
  targetRevision: string;
  prNumber?: number;
  owner: string;
  repo: string;
  headRef?: string;
  receivedAt: string;
  expiresAt: string;
};

/** Provider slugs are plain kebab-case names (`bugbot`, `codex-github`, …). */
const PROVIDER_SEGMENT_REGEX = /^[A-Za-z0-9-]+$/;

/** True when the three values can be used as a note's path segments. */
export function isExternalReviewReadinessKeySafe(
  productSlug: string,
  provider: string,
  targetRevision: string,
): boolean {
  return (
    isValidExternalId(productSlug) &&
    PROVIDER_SEGMENT_REGEX.test(provider) &&
    isValidExternalId(targetRevision)
  );
}

function assertSafeNoteKey(productSlug: string, provider: string, targetRevision: string): void {
  if (!isExternalReviewReadinessKeySafe(productSlug, provider, targetRevision)) {
    throw new Error('Unsafe external review readiness key');
  }
}

function ignoreMissing(err: NodeJS.ErrnoException): void {
  if (err.code !== 'ENOENT') throw err;
}

export class ExternalReviewReadinessStore {
  constructor(private readonly rootDir: string) {}

  private notePath(productSlug: string, provider: string, targetRevision: string): string {
    assertSafeNoteKey(productSlug, provider, targetRevision);
    // The provider segment has no dots, so `<provider>.<revision>` is unambiguous.
    return join(this.rootDir, productSlug, `${provider}.${targetRevision}.json`);
  }

  /** Upserts the note for this product + provider + revision. */
  async put(note: ExternalReviewReadinessNote): Promise<ExternalReviewReadinessNote> {
    const path = this.notePath(note.productSlug, note.provider, note.targetRevision);
    await mkdir(join(this.rootDir, note.productSlug), { recursive: true });
    const stored = { ...note };
    await writeJsonAtomic(path, stored);
    return { ...stored };
  }

  /** Returns the live note for the revision, or `null` when absent or expired. */
  async find(
    input: { productSlug: string; provider: string; targetRevision: string },
    now = new Date(),
  ): Promise<ExternalReviewReadinessNote | null> {
    const note = await readJson<ExternalReviewReadinessNote>(
      this.notePath(input.productSlug, input.provider, input.targetRevision),
    );
    if (!note) return null;
    if (
      note.productSlug !== input.productSlug ||
      note.provider !== input.provider ||
      note.targetRevision !== input.targetRevision
    ) {
      return null;
    }
    if (!(Date.parse(note.expiresAt) > now.getTime())) return null;
    return { ...note };
  }

  async remove(input: {
    productSlug: string;
    provider: string;
    targetRevision: string;
  }): Promise<void> {
    await unlink(this.notePath(input.productSlug, input.provider, input.targetRevision)).catch(
      ignoreMissing,
    );
  }

  /** Deletes expired (or unreadable-expiry) notes. Returns how many were removed. */
  async removeExpired(now = new Date()): Promise<number> {
    let productDirs: string[];
    try {
      productDirs = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let removed = 0;
    for (const productSlug of productDirs) {
      if (!isValidExternalId(productSlug)) continue;
      let entries: string[];
      try {
        entries = await readdir(join(this.rootDir, productSlug));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const path = join(this.rootDir, productSlug, entry);
        const note = await readJson<ExternalReviewReadinessNote>(path).catch(() => null);
        if (note && Date.parse(note.expiresAt) > now.getTime()) continue;
        await unlink(path).catch(ignoreMissing);
        removed += 1;
      }
    }
    return removed;
  }
}

export async function getExternalReviewReadinessStore(
  dataRoot: string,
): Promise<ExternalReviewReadinessStore> {
  const rootDir = join(dataRoot, 'external-review-readiness');
  await mkdir(rootDir, { recursive: true });
  return new ExternalReviewReadinessStore(rootDir);
}
