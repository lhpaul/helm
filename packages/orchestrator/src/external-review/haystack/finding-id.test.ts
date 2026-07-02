import { describe, expect, it } from 'vitest';
import { stableHaystackFindingId } from './finding-id.js';
import type { HaystackTriageFinding } from './types.js';

describe('stableHaystackFindingId', () => {
  it('uses provider-native id when present on the finding', () => {
    const finding: HaystackTriageFinding = {
      id: 'finding-9001',
      category: 'Logic error',
      summary: 'Changed summary text should not affect id',
    };
    expect(stableHaystackFindingId(finding)).toBe('haystack:finding-9001');
  });

  it('uses source id when finding id is absent', () => {
    const finding: HaystackTriageFinding = {
      category: 'Minor',
      summary: 'Nit',
      source: { id: 'src-42', path: 'src/a.ts', line: 10 },
    };
    expect(stableHaystackFindingId(finding)).toBe('haystack:src-42');
  });

  it('falls back to canonical signature (path, category, line)', () => {
    const finding: HaystackTriageFinding = {
      category: 'Rules violation',
      summary: 'First summary',
      source: { path: 'CHANGELOG.md', line: 12 },
    };
    expect(stableHaystackFindingId(finding)).toBe('haystack:CHANGELOG.md:Rules violation:12');
    expect(
      stableHaystackFindingId({
        ...finding,
        summary: 'Rewritten summary must not change id',
      }),
    ).toBe('haystack:CHANGELOG.md:Rules violation:12');
  });

  it('uses __UNKNOWN__ category in signature when category is missing', () => {
    const finding: HaystackTriageFinding = {
      summary: 'No category',
      source: { file: 'src/x.ts' },
    };
    expect(stableHaystackFindingId(finding)).toBe('haystack:src/x.ts:__UNKNOWN__:');
  });
});
