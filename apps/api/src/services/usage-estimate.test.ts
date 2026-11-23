import { describe, expect, it } from 'vitest';
import { estimateSessionCost } from './usage-estimate.js';
import type { PriceTable } from './usage-price-table.js';

// Test-only table with obviously fake round rates (not real prices).
const TABLE: PriceTable = {
  version: 'test',
  asOf: '2000-01-01',
  models: [
    {
      id: 'fake-claude',
      aliases: ['fake-claude-alias'],
      rates: { input: 1, cacheRead: 0.1, cacheCreation: 2, output: 10 },
      inputIncludesCacheRead: false,
      source: 'https://example.invalid',
      asOf: '2000-01-01',
    },
    {
      id: 'fake-gpt',
      rates: { input: 2, cacheRead: 0.2, output: 20 },
      inputIncludesCacheRead: true,
      source: 'https://example.invalid',
      asOf: '2000-01-01',
    },
    {
      id: 'huge',
      rates: { input: 1e300, cacheRead: 1e300, output: 1e300 },
      inputIncludesCacheRead: true,
      source: 'https://example.invalid',
      asOf: '2000-01-01',
    },
  ],
};

const tok = (o: Record<string, unknown> = {}) => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheCreation: null,
  reasoning: null,
  ...o,
});
const est = (tokens: unknown, model: unknown) => estimateSessionCost({ tokens, model }, TABLE);

describe('estimateSessionCost', () => {
  it('Anthropic-style formula (Claude fixture token counts)', () => {
    const r = est(
      tok({ input: 4, cacheCreation: 9429, cacheRead: 36446, output: 146 }),
      'fake-claude',
    );
    expect(r.usd).toBeCloseTo((4 * 1 + 36446 * 0.1 + 9429 * 2 + 146 * 10) / 1e6, 12);
  });

  it('OpenAI-style formula: input includes cache, reasoning not added, no cacheCreation needed', () => {
    const r = est(tok({ input: 47925, cacheRead: 35968, output: 939, reasoning: 652 }), 'fake-gpt');
    expect(r.usd).toBeCloseTo(((47925 - 35968) * 2 + 35968 * 0.2 + 939 * 20) / 1e6, 12);
  });

  it('resolves declared aliases but never prefixes', () => {
    const t = tok({ input: 1, output: 1, cacheRead: 1, cacheCreation: 1 });
    expect(est(t, 'fake-claude-alias').usd).not.toBeNull();
    expect(est(t, 'fake-claude-2')).toMatchObject({ usd: null, reason: 'noPrice' });
  });

  it('reason codes and precedence', () => {
    const all = tok({ input: 1, output: 1, cacheRead: 1, cacheCreation: 1 });
    expect(est(tok(), null)).toEqual({ usd: null, reason: 'noTokens' });
    expect(est(tok(), 'unknown')).toEqual({ usd: null, reason: 'noTokens' });
    expect(est(all, null)).toEqual({ usd: null, reason: 'noModel' });
    expect(est(tok({ input: 1 }), null)).toMatchObject({ reason: 'noModel' });
    expect(est(all, 'a,b')).toMatchObject({ reason: 'multiModel' });
    expect(est(tok({ input: 1 }), 'unknown')).toMatchObject({
      reason: 'noPrice',
      model: 'unknown',
    });
    expect(est(tok({ input: 1 }), 'fake-claude')).toMatchObject({ reason: 'incompleteTokens' });
    expect(est(tok({ input: 1, output: 1, cacheRead: 1 }), 'fake-claude')).toMatchObject({
      reason: 'incompleteTokens',
    });
    expect(est(tok({ input: 1, output: 1, cacheRead: 1 }), 'fake-gpt').usd).not.toBeNull();
    expect(est(tok({ input: 1, output: 1, cacheRead: 5 }), 'fake-gpt')).toMatchObject({
      reason: 'inconsistentTokens',
    });
  });

  it('measured zeros estimate 0; all null is noTokens, never 0', () => {
    expect(
      est(tok({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }), 'fake-claude'),
    ).toEqual({
      usd: 0,
    });
    expect(est(tok(), 'fake-claude')).toMatchObject({ usd: null });
  });

  it('failure-path records (all null) are noTokens', () => {
    expect(estimateSessionCost({ tokens: tok(), model: 'fake-gpt' }, TABLE)).toEqual({
      usd: null,
      reason: 'noTokens',
    });
  });

  it('invalid counters are treated as null and never give negative or non-finite values', () => {
    const bad = [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, '5', undefined];
    for (const v of bad) {
      expect(
        est(tok({ input: v, output: v, cacheRead: v, cacheCreation: v }), 'fake-claude'),
      ).toEqual({
        usd: null,
        reason: 'noTokens',
      });
      expect(
        est(tok({ input: v, output: 1, cacheRead: 1, cacheCreation: 1 }), 'fake-claude'),
      ).toMatchObject({ reason: 'incompleteTokens' });
    }
    expect(estimateSessionCost({ tokens: null, model: 'fake-gpt' }, TABLE)).toMatchObject({
      reason: 'noTokens',
    });
  });

  it('overflow becomes inconsistentTokens', () => {
    const m = Number.MAX_SAFE_INTEGER;
    expect(est(tok({ input: m, output: m, cacheRead: 0 }), 'huge')).toEqual({
      usd: null,
      reason: 'inconsistentTokens',
    });
  });

  it('does not read costUsd', () => {
    const r = estimateSessionCost(
      {
        tokens: tok({ input: 1, output: 1, cacheRead: 0 }),
        model: 'fake-gpt',
        costUsd: 99,
      } as never,
      TABLE,
    );
    expect(r.usd).toBeCloseTo((1 * 2 + 1 * 20) / 1e6, 12);
  });
});
