import type { PriceEntry, PriceTable } from './usage-price-table.js';
import { PRICE_TABLE, lookupPrice } from './usage-price-table.js';

/**
 * Per-session USD ESTIMATE from tokens and the price table (#168, spec
 * `issue_168`). Pure. Reads only `tokens` and `model`; never `costUsd`,
 * `costSource` or any legacy cost field.
 */

export const ESTIMATE_NOTE =
  'estimate: what this usage would cost at public API list price, not a billed amount; all cache writes use a single rate';

export const NOT_ESTIMATED_REASONS = [
  'noTokens',
  'noModel',
  'multiModel',
  'noPrice',
  'incompleteTokens',
  'inconsistentTokens',
] as const;
export type NotEstimatedReason = (typeof NOT_ESTIMATED_REASONS)[number];

export type SessionEstimate =
  | { usd: number }
  | { usd: null; reason: NotEstimatedReason; model?: string };

const KEYS = ['input', 'output', 'cacheRead', 'cacheCreation', 'reasoning'] as const;

function counter(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

export function estimateSessionCost(
  record: { tokens?: unknown; model?: unknown },
  table: PriceTable = PRICE_TABLE,
): SessionEstimate {
  const raw = (record.tokens && typeof record.tokens === 'object' ? record.tokens : {}) as Record<
    string,
    unknown
  >;
  const t = Object.fromEntries(KEYS.map((k) => [k, counter(raw[k])])) as Record<
    (typeof KEYS)[number],
    number | null
  >;
  if (KEYS.every((k) => t[k] === null)) return { usd: null, reason: 'noTokens' };

  const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : null;
  if (model === null) return { usd: null, reason: 'noModel' };
  if (model.includes(',')) return { usd: null, reason: 'multiModel' };

  const entry: PriceEntry | undefined = lookupPrice(model, table);
  if (!entry) return { usd: null, reason: 'noPrice', model };

  const { rates } = entry;
  const needsCreation = rates.cacheCreation !== undefined;
  if (
    t.input === null ||
    t.output === null ||
    t.cacheRead === null ||
    (needsCreation && t.cacheCreation === null)
  ) {
    return { usd: null, reason: 'incompleteTokens' };
  }
  if (entry.inputIncludesCacheRead && t.cacheRead > t.input) {
    return { usd: null, reason: 'inconsistentTokens' };
  }

  const uncachedInput = entry.inputIncludesCacheRead ? t.input - t.cacheRead : t.input;
  const usd =
    (uncachedInput * rates.input +
      t.cacheRead * rates.cacheRead +
      (needsCreation ? t.cacheCreation! * rates.cacheCreation! : 0) +
      t.output * rates.output) /
    1_000_000;
  if (!Number.isFinite(usd)) return { usd: null, reason: 'inconsistentTokens' };
  return { usd };
}
