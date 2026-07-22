import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getReviewDispatchOutbox } from './review-dispatch-outbox.js';

describe('ReviewDispatchOutbox', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'helm-outbox-'));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('stores intents under nested product/externalId paths without -- collisions', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const a = await outbox.put({
      productSlug: 'foo-bar',
      externalId: 'baz',
      triggeredBy: 'test',
      targetRevision: 'sha-1',
    });
    const b = await outbox.put({
      productSlug: 'foo',
      externalId: 'bar-baz',
      triggeredBy: 'test',
      targetRevision: 'sha-2',
    });

    expect(await outbox.get('foo-bar', 'baz')).toEqual(a);
    expect(await outbox.get('foo', 'bar-baz')).toEqual(b);
    expect(a.targetRevision).not.toBe(b.targetRevision);
  });

  it('removeIfMatches keeps a newer concurrent intent', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const first = await outbox.put({
      productSlug: 'helm',
      externalId: 'issue_1',
      triggeredBy: 't1',
      targetRevision: 'sha-a',
    });
    const newer = await outbox.put({
      productSlug: 'helm',
      externalId: 'issue_1',
      triggeredBy: 't2',
      targetRevision: 'sha-b',
    });

    const removed = await outbox.removeIfMatches('helm', 'issue_1', {
      updatedAt: first.updatedAt,
      targetRevision: first.targetRevision,
    });
    expect(removed).toBe(false);
    expect(await outbox.get('helm', 'issue_1')).toEqual(newer);

    const removedNewer = await outbox.removeIfMatches('helm', 'issue_1', {
      updatedAt: newer.updatedAt,
      targetRevision: newer.targetRevision,
    });
    expect(removedNewer).toBe(true);
    expect(await outbox.get('helm', 'issue_1')).toBeNull();
  });

  it('stores pending external review intents idempotently for the same revision', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const first = await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'helm',
      externalId: 'issue_78',
      provider: 'haystack',
      reason: 'analysis_pending',
      prNumber: 42,
      targetRevision: 'abc123',
      createdAt: '2026-07-22T10:00:00.000Z',
      expiresAt: '2026-07-22T10:30:00.000Z',
      triggeredBy: 'test:first',
    });
    const second = await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'helm',
      externalId: 'issue_78',
      provider: 'haystack',
      reason: 'analysis_pending',
      prNumber: 42,
      targetRevision: 'abc123',
      expiresAt: '2026-07-22T10:45:00.000Z',
      triggeredBy: 'test:retry',
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe('');
    await expect(
      outbox.findPendingExternalReview({
        productSlug: 'helm',
        externalId: 'issue_78',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'abc123',
      }),
    ).resolves.toEqual(second);
  });

  it('does not match pending external review readiness for the wrong revision', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'helm',
      externalId: 'issue_78',
      provider: 'haystack',
      reason: 'analysis_pending',
      prNumber: 42,
      targetRevision: 'abc123',
      expiresAt: '2099-01-01T00:00:00.000Z',
      triggeredBy: 'test',
    });

    await expect(
      outbox.findPendingExternalReview({
        productSlug: 'helm',
        externalId: 'issue_78',
        provider: 'haystack',
        prNumber: 42,
        targetRevision: 'def456',
      }),
    ).resolves.toBeNull();
  });

  it('removeIfMatches keeps a pending external review when full identity differs', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const intent = await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'helm',
      externalId: 'issue_78',
      provider: 'haystack',
      reason: 'analysis_pending',
      prNumber: 42,
      targetRevision: 'abc123',
      expiresAt: '2099-01-01T00:00:00.000Z',
      triggeredBy: 'test',
    });

    await expect(
      outbox.removeIfMatches('helm', 'issue_78', {
        kind: 'pending_external_review',
        updatedAt: intent.updatedAt,
        targetRevision: intent.targetRevision,
        provider: 'other-provider',
        reason: intent.reason,
        prNumber: intent.prNumber,
      }),
    ).resolves.toBe(false);
    await expect(outbox.get('helm', 'issue_78', 'pending_external_review')).resolves.toEqual(
      intent,
    );
  });

  it('keeps review_dispatch and pending_external_review intents side by side', async () => {
    const outbox = await getReviewDispatchOutbox(dataRoot);
    const dispatch = await outbox.put({
      kind: 'review_dispatch',
      productSlug: 'helm',
      externalId: 'issue_78',
      prNumber: 42,
      targetRevision: 'sha-dispatch',
      triggeredBy: 'test:dispatch',
    });
    const pending = await outbox.put({
      kind: 'pending_external_review',
      productSlug: 'helm',
      externalId: 'issue_78',
      provider: 'haystack',
      reason: 'analysis_pending',
      prNumber: 42,
      targetRevision: 'sha-pending',
      expiresAt: '2099-01-01T00:00:00.000Z',
      triggeredBy: 'test:defer',
    });

    expect(await outbox.get('helm', 'issue_78', 'review_dispatch')).toEqual(dispatch);
    expect(await outbox.get('helm', 'issue_78', 'pending_external_review')).toEqual(pending);
    await expect(
      outbox.findPendingExternalReviewByRevision({
        productSlug: 'helm',
        provider: 'haystack',
        targetRevision: 'sha-pending',
      }),
    ).resolves.toEqual(pending);
  });
});
