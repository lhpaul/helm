import { describe, expect, it } from 'vitest';
import { parseLinearWebhook } from './webhook-parser.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function issueEvent(
  action: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'Issue',
    action,
    data: {
      identifier: 'MOM-42',
      labelIds: [],
      stateId: 'state-open',
      state: { type: 'started' },
      labels: [],
      ...overrides,
    },
    createdAt: '2024-01-01T00:00:00Z',
  };
}

function commentEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Comment',
    action: 'create',
    data: {
      body: 'LGTM',
      issue: { identifier: 'MOM-42' },
      ...overrides,
    },
    createdAt: '2024-01-01T00:00:00Z',
  };
}

// ── Issue events ──────────────────────────────────────────────────────────────

describe('parseLinearWebhook — Issue events', () => {
  it('Issue.create → item_created', () => {
    const result = parseLinearWebhook(issueEvent('create'));
    expect(result).toMatchObject({ type: 'item_created', externalId: 'MOM-42' });
    expect('timestamp' in result).toBe(true);
  });

  it('Issue.update with label change → item_updated with subStage', () => {
    const result = parseLinearWebhook({
      ...issueEvent('update', {
        labelIds: ['label-disc'],
        labels: [{ id: 'label-disc', name: 'helm:discovery' }],
      }),
      updatedFrom: { labelIds: [] },
    });
    expect(result).toMatchObject({
      type: 'item_updated',
      externalId: 'MOM-42',
      subStage: 'discovery',
    });
  });

  it('Issue.update with state change to completed → item_updated with status closed', () => {
    const result = parseLinearWebhook({
      ...issueEvent('update', {
        stateId: 'state-done',
        state: { type: 'completed' },
      }),
      updatedFrom: { stateId: 'state-open' },
    });
    expect(result).toMatchObject({
      type: 'item_updated',
      externalId: 'MOM-42',
      status: 'closed',
    });
  });

  it('Issue.update with state change to started → item_updated with status open', () => {
    const result = parseLinearWebhook({
      ...issueEvent('update', {
        stateId: 'state-started',
        state: { type: 'started' },
      }),
      updatedFrom: { stateId: 'state-done' },
    });
    expect(result).toMatchObject({
      type: 'item_updated',
      externalId: 'MOM-42',
      status: 'open',
    });
  });

  it('Issue.update with both label and state change → item_updated with both fields', () => {
    const result = parseLinearWebhook({
      ...issueEvent('update', {
        labelIds: ['label-disc'],
        labels: [{ id: 'label-disc', name: 'helm:discovery' }],
        stateId: 'state-done',
        state: { type: 'completed' },
      }),
      updatedFrom: { labelIds: [], stateId: 'state-open' },
    });
    expect(result).toMatchObject({
      type: 'item_updated',
      externalId: 'MOM-42',
      subStage: 'discovery',
      status: 'closed',
    });
  });

  it('Issue.update with no tracked changes → unknown', () => {
    const result = parseLinearWebhook(issueEvent('update'));
    expect(result.type).toBe('unknown');
  });

  it('Issue.remove → unknown (not actionable)', () => {
    const result = parseLinearWebhook(issueEvent('remove'));
    expect(result.type).toBe('unknown');
  });

  it('Issue.update with non-helm label change → item_updated with subStage null', () => {
    const result = parseLinearWebhook({
      ...issueEvent('update', {
        labelIds: ['label-other'],
        labels: [{ id: 'label-other', name: 'bug' }],
      }),
      updatedFrom: { labelIds: [] },
    });
    expect(result).toMatchObject({
      type: 'item_updated',
      externalId: 'MOM-42',
      subStage: null,
    });
  });
});

// ── Comment events ────────────────────────────────────────────────────────────

describe('parseLinearWebhook — Comment events', () => {
  it('Comment.create → comment_added', () => {
    const result = parseLinearWebhook(commentEvent());
    expect(result).toMatchObject({
      type: 'comment_added',
      externalId: 'MOM-42',
      body: 'LGTM',
    });
  });

  it('Comment.update → unknown (not actionable)', () => {
    const result = parseLinearWebhook({ ...commentEvent(), action: 'update' });
    expect(result.type).toBe('unknown');
  });

  it('Comment.create without issue → unknown', () => {
    const result = parseLinearWebhook(commentEvent({ issue: undefined }));
    expect(result.type).toBe('unknown');
  });
});

// ── Unknown / malformed inputs ────────────────────────────────────────────────

describe('parseLinearWebhook — unknown and malformed inputs', () => {
  it('null → unknown (no throw)', () => {
    expect(parseLinearWebhook(null)).toMatchObject({ type: 'unknown' });
  });

  it('string → unknown (no throw)', () => {
    expect(parseLinearWebhook('not-an-object')).toMatchObject({ type: 'unknown' });
  });

  it('unknown type → unknown', () => {
    expect(parseLinearWebhook({ type: 'Cycle', action: 'create', data: {} })).toMatchObject({
      type: 'unknown',
    });
  });

  it('Issue event without identifier → unknown', () => {
    const raw = { type: 'Issue', action: 'create', data: { title: 'no identifier' } };
    const result = parseLinearWebhook(raw);
    expect(result.type).toBe('unknown');
  });

  it('never throws — even on deeply broken payload', () => {
    expect(() => parseLinearWebhook({ type: 'Issue', action: 'create', data: null })).not.toThrow();
  });
});
