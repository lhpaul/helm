import { describe, expect, it } from 'vitest';
import { haystackCategoryToSeverity, isHaystackCategoryBlocking } from './category.js';

describe('isHaystackCategoryBlocking', () => {
  it('treats Logic error and Critical as blocking', () => {
    expect(isHaystackCategoryBlocking('Logic error', false)).toBe(true);
    expect(isHaystackCategoryBlocking('Critical', false)).toBe(true);
  });

  it('treats Major as advisory unless major_is_blocking is enabled', () => {
    expect(isHaystackCategoryBlocking('Major', false)).toBe(false);
    expect(isHaystackCategoryBlocking('Major', true)).toBe(true);
  });

  it('treats style and rules categories as advisory', () => {
    for (const category of [
      'Minor',
      'Advisory',
      'Nitpick',
      'Trivial',
      'Weak test coverage',
      'Rules violation',
      'Code contract violation',
    ]) {
      expect(isHaystackCategoryBlocking(category, false)).toBe(false);
    }
  });

  it('safe-fails unknown and empty categories to blocking', () => {
    expect(isHaystackCategoryBlocking('Unexpected category', false)).toBe(true);
    expect(isHaystackCategoryBlocking('', false)).toBe(true);
    expect(isHaystackCategoryBlocking(undefined, false)).toBe(true);
  });
});

describe('haystackCategoryToSeverity', () => {
  it('maps categories to normalized severities', () => {
    expect(haystackCategoryToSeverity('Logic error')).toBe('critical');
    expect(haystackCategoryToSeverity('Major')).toBe('high');
    expect(haystackCategoryToSeverity('Rules violation')).toBe('low');
    expect(haystackCategoryToSeverity('Nitpick')).toBe('info');
    expect(haystackCategoryToSeverity('Unknown')).toBe('high');
  });
});
