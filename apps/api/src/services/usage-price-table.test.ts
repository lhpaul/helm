import { describe, expect, it } from 'vitest';
import { PRICE_TABLE, lookupPrice } from './usage-price-table.js';

describe('shipped price table', () => {
  it('has version, asOf and entries', () => {
    expect(PRICE_TABLE.version).toMatch(/\S/);
    expect(PRICE_TABLE.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICE_TABLE.models.length).toBeGreaterThan(0);
  });

  it('every rate is finite and non-negative; every entry cites a source and a date', () => {
    for (const m of PRICE_TABLE.models) {
      for (const v of Object.values(m.rates)) {
        expect(Number.isFinite(v) && v >= 0).toBe(true);
      }
      expect(m.rates.input).toBeDefined();
      expect(m.rates.output).toBeDefined();
      expect(m.rates.cacheRead).toBeDefined();
      expect(m.source).toMatch(/^https:\/\//);
      expect(m.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Anthropic-style entries bill cache writes; OpenAI-style include cache in input.
      expect(m.rates.cacheCreation !== undefined).toBe(!m.inputIncludesCacheRead);
    }
  });

  it('ids and aliases are unique across all entries', () => {
    const names = PRICE_TABLE.models.flatMap((m) => [m.id, ...(m.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lookupPrice is exact only', () => {
    expect(lookupPrice(PRICE_TABLE.models[0]!.id)).toBeDefined();
    expect(lookupPrice(`${PRICE_TABLE.models[0]!.id}-x`)).toBeUndefined();
  });

  it('models without a traceable price stay unpriced', () => {
    for (const id of [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-haiku-5-5',
    ]) {
      expect(lookupPrice(id)).toBeUndefined();
    }
  });
});
