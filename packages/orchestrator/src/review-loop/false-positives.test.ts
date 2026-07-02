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
});
