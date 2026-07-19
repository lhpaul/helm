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
});
