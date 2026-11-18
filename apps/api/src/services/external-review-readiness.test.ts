import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getExternalReviewReadinessStore,
  isExternalReviewReadinessKeySafe,
  type ExternalReviewReadinessNote,
} from './external-review-readiness.js';

const key = { productSlug: 'helm', provider: 'codex-github', targetRevision: 'a'.repeat(40) };

function note(overrides: Partial<ExternalReviewReadinessNote> = {}): ExternalReviewReadinessNote {
  return {
    ...key,
    prNumber: 7,
    owner: 'o',
    repo: 'r',
    headRef: 'helm/impl/issue_7',
    receivedAt: '2026-11-12T10:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ExternalReviewReadinessStore', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'helm-readiness-'));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('round-trips a note outside the review-dispatch outbox', async () => {
    const store = await getExternalReviewReadinessStore(dataRoot);
    await store.put(note());

    await expect(store.find(key)).resolves.toEqual(note());
    await expect(readdir(join(dataRoot, 'external-review-readiness', 'helm'))).resolves.toEqual([
      `codex-github.${'a'.repeat(40)}.json`,
    ]);
    await expect(readdir(dataRoot)).resolves.not.toContain('review-dispatch-outbox');
  });

  it('upserts the same revision and removes it', async () => {
    const store = await getExternalReviewReadinessStore(dataRoot);
    await store.put(note({ prNumber: 7 }));
    await store.put(note({ prNumber: 8 }));

    await expect(store.find(key)).resolves.toMatchObject({ prNumber: 8 });
    await store.remove(key);
    await expect(store.find(key)).resolves.toBeNull();
    await expect(store.remove(key)).resolves.toBeUndefined();
  });

  it('treats an expired note as absent', async () => {
    const store = await getExternalReviewReadinessStore(dataRoot);
    await store.put(note({ expiresAt: '2026-11-12T10:30:00.000Z' }));

    await expect(store.find(key, new Date('2026-11-12T10:29:59.000Z'))).resolves.not.toBeNull();
    await expect(store.find(key, new Date('2026-11-12T10:30:00.000Z'))).resolves.toBeNull();
  });

  it('sweeps expired and unreadable notes only', async () => {
    const store = await getExternalReviewReadinessStore(dataRoot);
    await store.put(note());
    await store.put(
      note({ targetRevision: 'b'.repeat(40), expiresAt: '2026-01-01T00:00:00.000Z' }),
    );
    await writeFile(
      join(dataRoot, 'external-review-readiness', 'helm', `bugbot.${'c'.repeat(40)}.json`),
      '{not json',
    );

    await expect(store.removeExpired(new Date('2026-11-12T00:00:00.000Z'))).resolves.toBe(2);
    await expect(store.find(key)).resolves.not.toBeNull();
    await expect(readdir(join(dataRoot, 'external-review-readiness', 'helm'))).resolves.toEqual([
      `codex-github.${'a'.repeat(40)}.json`,
    ]);
  });

  it('rejects unsafe path segments', async () => {
    const store = await getExternalReviewReadinessStore(dataRoot);

    expect(isExternalReviewReadinessKeySafe('helm', 'bugbot', 'a'.repeat(40))).toBe(true);
    expect(isExternalReviewReadinessKeySafe('../x', 'bugbot', 'sha')).toBe(false);
    expect(isExternalReviewReadinessKeySafe('helm', 'bug.bot', 'sha')).toBe(false);
    expect(isExternalReviewReadinessKeySafe('helm', 'bugbot', '../sha')).toBe(false);
    expect(isExternalReviewReadinessKeySafe('helm', 'bugbot', '.hidden')).toBe(false);
    await expect(store.put(note({ targetRevision: '../escape' }))).rejects.toThrow(
      'Unsafe external review readiness key',
    );
  });
});
