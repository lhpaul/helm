import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import {
  builtInFalsePositiveEntries,
  fetchFalsePositivesCatalog,
  parseFalsePositivesCatalog,
} from './false-positives.js';

const SAMPLE = `# Code-review false positives

---

## Health endpoint returns degraded

**Pattern:** A reviewer flags the \`/health\` endpoint for returning extra data

**Applies to:** code-review

**Why it's a false positive:** This behavior is spec-intended for fail-open visibility.

**Example:** Flagged on PR #3 — dismissed.
`;

describe('parseFalsePositivesCatalog', () => {
  it('parses pattern and rationale from knowledge-repo markdown', () => {
    const entries = parseFalsePositivesCatalog(SAMPLE);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toContain('Health endpoint');
    expect(entries[0]!.matchesSummary('Haystack flags /health endpoint extra data')).toBe(true);
  });

  it('returns empty array for header-only content', () => {
    expect(parseFalsePositivesCatalog('# Code-review false positives\n')).toEqual([]);
  });

  it('splits sections when separators use Windows newlines or blank-line padding', () => {
    const markdown = `# Code-review false positives

---

## First entry

**Pattern:** alpha pattern one two three four

**Why it's a false positive:** First rationale.

---

## Second entry

**Pattern:** beta pattern one two three four

**Why it's a false positive:** Second rationale.
`.replace(/\n/g, '\r\n');

    const entries = parseFalsePositivesCatalog(markdown);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toContain('First');
    expect(entries[1]!.title).toContain('Second');
  });

  it('does not match catalog tokens as substrings inside unrelated words', () => {
    const entries = parseFalsePositivesCatalog(`${SAMPLE}

---

## Health token

**Pattern:** reviewer flags health endpoint contract

**Why it's a false positive:** Spec-intended health behavior.
`);
    const healthEntry = entries.find((e) => e.title.includes('Health token'))!;
    expect(healthEntry.matchesSummary('unhealthy retry logic in parser')).toBe(false);
    expect(healthEntry.matchesSummary('reviewer flags health endpoint contract')).toBe(true);
  });

  it('parses optional applies-to metadata for sequential artifact entries', () => {
    const entries = parseFalsePositivesCatalog(`# Code-review false positives

---

## Pair spec and plan files

**Pattern:** pair-spec-and-plan-files

**Applies to:** spec-draft, plan-draft

**Why it's a false positive:** Draft artifacts are reviewed sequentially.
`);

    expect(entries[0]).toMatchObject({
      title: 'Pair spec and plan files',
      pattern: 'pair-spec-and-plan-files',
      appliesTo: ['spec-draft', 'plan-draft'],
    });
    expect(entries[0]!.matchesSummary('Reviewer flags pair spec and plan files')).toBe(true);
  });

  it('ships built-in Helm sequential-artifact false positives', () => {
    const entries = builtInFalsePositiveEntries();
    const pairEntry = entries.find((entry) => entry.pattern === 'pair-spec-and-plan-files');

    expect(pairEntry).toBeDefined();
    expect(pairEntry?.appliesTo).toEqual(['spec-draft', 'plan-draft']);
    expect(pairEntry?.matchesSummary('pair-spec-and-plan-files sequencing')).toBe(true);
  });

  it('falls back to built-in entries when the knowledge-repo catalog fetch fails', async () => {
    const product = {
      knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
    } as Product;
    const fetchFn = async () => {
      throw new Error('transient network failure');
    };

    const entries = await fetchFalsePositivesCatalog(product, 'token', fetchFn);

    expect(entries.some((entry) => entry.pattern === 'pair-spec-and-plan-files')).toBe(true);
  });

  it('merges built-in sequential-artifact entries with a fetched knowledge-repo catalog', async () => {
    const product = {
      knowledge_repo: { url: 'https://github.com/o/k', default_branch: 'main' },
    } as Product;
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE,
    });

    const entries = await fetchFalsePositivesCatalog(product, 'token', fetchFn);

    expect(entries.map((entry) => entry.pattern)).toEqual(
      expect.arrayContaining([
        'pair-spec-and-plan-files',
        'A reviewer flags the `/health` endpoint for returning extra data',
      ]),
    );
    expect(
      entries.find((entry) => entry.pattern === 'pair-spec-and-plan-files')?.appliesTo,
    ).toEqual(['spec-draft', 'plan-draft']);
    expect(
      entries.find(
        (entry) =>
          entry.pattern === 'A reviewer flags the `/health` endpoint for returning extra data',
      )?.appliesTo,
    ).toEqual(['code-review']);
  });
});
