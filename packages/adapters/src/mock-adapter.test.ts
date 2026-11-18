import { beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from './mock-adapter.js';
import type { NormalizedItem } from './types.js';

const ITEM_A: NormalizedItem = {
  externalId: 'ITEM-1',
  title: 'First item',
  subStage: 'discovery',
  status: 'open',
  url: 'https://example.com/1',
};

const ITEM_B: NormalizedItem = {
  externalId: 'ITEM-2',
  title: 'Second item',
  subStage: 'spec-ready',
  status: 'closed',
  url: 'https://example.com/2',
};

describe('MockAdapter', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  describe('getItem', () => {
    it('returns null for unknown id', async () => {
      expect(await adapter.getItem('MISSING')).toBeNull();
    });

    it('returns a seeded item', async () => {
      adapter.seed(ITEM_A);
      const result = await adapter.getItem('ITEM-1');
      expect(result).toEqual(ITEM_A);
    });
  });

  describe('listItems', () => {
    beforeEach(() => {
      adapter.seed(ITEM_A);
      adapter.seed(ITEM_B);
    });

    it('returns all items when no filter given', async () => {
      const items = await adapter.listItems();
      expect(items).toHaveLength(2);
    });

    it('filters by status', async () => {
      const open = await adapter.listItems({ status: 'open' });
      expect(open).toHaveLength(1);
      expect(open[0]!.externalId).toBe('ITEM-1');
    });

    it('filters by subStage', async () => {
      const results = await adapter.listItems({ subStage: 'spec-ready' });
      expect(results).toHaveLength(1);
      expect(results[0]!.externalId).toBe('ITEM-2');
    });

    it('combines status and subStage filters', async () => {
      const results = await adapter.listItems({ status: 'open', subStage: 'spec-ready' });
      expect(results).toHaveLength(0);
    });
  });

  describe('setSubStage', () => {
    it('updates the subStage on an existing item', async () => {
      adapter.seed(ITEM_A);
      await adapter.setSubStage('ITEM-1', 'plan-ready');
      const item = await adapter.getItem('ITEM-1');
      expect(item!.subStage).toBe('plan-ready');
    });

    it('throws when item is not found', async () => {
      await expect(adapter.setSubStage('MISSING', 'plan-ready')).rejects.toThrow(
        'Item not found: MISSING',
      );
    });
  });

  describe('setStatus', () => {
    it('updates the status on an existing item', async () => {
      adapter.seed(ITEM_A);
      await adapter.setStatus('ITEM-1', 'closed');
      const item = await adapter.getItem('ITEM-1');
      expect(item!.status).toBe('closed');
    });

    it('throws when item is not found', async () => {
      await expect(adapter.setStatus('MISSING', 'closed')).rejects.toThrow(
        'Item not found: MISSING',
      );
    });
  });

  describe('comment', () => {
    it('appends a comment to an existing item', async () => {
      adapter.seed(ITEM_A);
      await adapter.comment('ITEM-1', 'first');
      await adapter.comment('ITEM-1', 'second');
      expect(adapter.getComments('ITEM-1')).toEqual(['first', 'second']);
    });

    it('throws when item is not found', async () => {
      await expect(adapter.comment('MISSING', 'hello')).rejects.toThrow('Item not found: MISSING');
    });

    it('getComments returns a copy', async () => {
      adapter.seed(ITEM_A);
      await adapter.comment('ITEM-1', 'original');
      const copy = adapter.getComments('ITEM-1');
      copy.push('mutation');
      expect(adapter.getComments('ITEM-1')).toHaveLength(1);
    });
  });

  describe('parseWebhook', () => {
    it('passes through a recognised event object', () => {
      const event = {
        type: 'item_created',
        externalId: 'ITEM-1',
        timestamp: '2024-01-01T00:00:00Z',
      };
      expect(adapter.parseWebhook(event)).toEqual(event);
    });

    it('returns unknown event for null', () => {
      expect(adapter.parseWebhook(null)).toEqual({ type: 'unknown', raw: null });
    });

    it('returns unknown event for a plain string', () => {
      expect(adapter.parseWebhook('gibberish')).toEqual({ type: 'unknown', raw: 'gibberish' });
    });

    it('returns unknown event when type is "unknown"', () => {
      const raw = { type: 'unknown', raw: 'x' };
      expect(adapter.parseWebhook(raw)).toEqual({ type: 'unknown', raw });
    });

    it('returns unknown event when type is a non-string value', () => {
      const raw = { type: 123 };
      expect(adapter.parseWebhook(raw)).toEqual({ type: 'unknown', raw });
    });
  });

  describe('ensureSubStages / registerWebhook', () => {
    it('ensureSubStages resolves without error', async () => {
      await expect(adapter.ensureSubStages()).resolves.toBeUndefined();
    });

    it('registerWebhook resolves without error', async () => {
      await expect(adapter.registerWebhook()).resolves.toBeUndefined();
    });
  });
});
