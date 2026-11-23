/**
 * Price table for the USD ESTIMATE (#168, ADR-047 option A).
 *
 * Public list prices, USD per 1,000,000 tokens, copied from each provider's
 * public pricing page (URL and date read per entry). Not billed amounts and
 * never mixed with the runtime-reported `costUsd`. A model that is not listed
 * is `noPrice` (estimate `null`), never guessed. Review monthly; every edit is
 * reviewed in a PR. Not modelled: tiered / long-context pricing, batch, fast
 * mode, tool fees, the 1-hour cache-write tier (all cache writes use the
 * 5-minute rate), regional multipliers.
 */

export interface PriceRates {
  /** Uncached input. */
  input: number;
  /** Cache read / cached input. */
  cacheRead: number;
  /** Cache write; only for providers that bill it. */
  cacheCreation?: number;
  /** Output (includes reasoning tokens). */
  output: number;
}

export interface PriceEntry {
  /** Model id as the runtime reports it. */
  id: string;
  aliases?: readonly string[];
  rates: PriceRates;
  /** true: `input` counter already contains `cacheRead` (Codex-style). */
  inputIncludesCacheRead: boolean;
  /** Public URL the rates were copied from. */
  source: string;
  /** YYYY-MM-DD the source was read. */
  asOf: string;
}

export interface PriceTable {
  version: string;
  asOf: string;
  models: readonly PriceEntry[];
}

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const READ = '2026-11-23';

/** Anthropic-style entry. `cacheCreation` is the 5-minute cache-write rate. */
const claude = (
  id: string,
  input: number,
  cacheCreation: number,
  cacheRead: number,
  output: number,
): PriceEntry => ({
  id,
  rates: { input, cacheRead, cacheCreation, output },
  inputIncludesCacheRead: false,
  source: ANTHROPIC,
  asOf: READ,
});

/** OpenAI-style entry, standard processing, short context (<272K where tiered). */
const openai = (id: string, input: number, cacheRead: number, output: number): PriceEntry => ({
  id,
  rates: { input, cacheRead, output },
  inputIncludesCacheRead: true,
  source: OPENAI,
  asOf: READ,
});

// Left out on purpose (no single list price per token type): Claude Haiku 5.5
// (price depends on prompt size, tiers are not modelled). They show as
// `noPrice` / `unpricedModels`.
export const PRICE_TABLE: PriceTable = {
  version: '2026-11-23.1',
  asOf: READ,
  models: [
    claude('claude-fable-5-2', 8, 10, 0.2, 40),
    claude('claude-opus-5-5', 4, 5, 0.2, 20),
    claude('claude-opus-4-8', 5, 6.25, 0.5, 25),
    claude('claude-opus-4-7', 5, 6.25, 0.5, 25),
    claude('claude-opus-4-6', 5, 6.25, 0.5, 25),
    claude('claude-sonnet-5-5', 2, 2.5, 0.1, 10),
    claude('claude-sonnet-5', 2, 2.5, 0.2, 10),
    claude('claude-sonnet-4-6', 3, 3.75, 0.3, 15),
    openai('gpt-5.5', 5, 0.5, 30),
    openai('gpt-5.4', 2.5, 0.25, 15),
    openai('gpt-5.4-mini', 0.75, 0.075, 4.5),
  ],
};

/** Exact id or declared alias; no prefix or fuzzy matching. */
export function lookupPrice(
  modelId: string,
  table: PriceTable = PRICE_TABLE,
): PriceEntry | undefined {
  return table.models.find((m) => m.id === modelId || m.aliases?.includes(modelId));
}
