import { describe, expect, it } from 'vitest';
import { parseFalsePositivesCatalog } from './false-positives.js';

const SAMPLE = `# Code-review false positives

---

## Health endpoint returns degraded

**Pattern:** A reviewer flags the \`/health\` endpoint for returning extra data

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
});
