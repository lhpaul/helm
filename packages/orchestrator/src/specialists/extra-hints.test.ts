import { describe, expect, it } from 'vitest';
import { buildExtraHintsSection } from './extra-hints.js';

describe('buildExtraHintsSection', () => {
  it('returns an empty string when hints is undefined', () => {
    expect(buildExtraHintsSection(undefined)).toBe('');
  });

  it('returns an empty string when hints is an empty array', () => {
    expect(buildExtraHintsSection([])).toBe('');
  });

  it('renders a single hint as one bullet under ## Hints', () => {
    const section = buildExtraHintsSection(['Pin exact versions.']);
    expect(section).toContain('## Hints');
    expect(section).toContain('- Pin exact versions.');
  });

  it('preserves the order of multiple hints', () => {
    const section = buildExtraHintsSection(['first', 'second', 'third']);
    const firstIdx = section.indexOf('- first');
    const secondIdx = section.indexOf('- second');
    const thirdIdx = section.indexOf('- third');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it('ends with a markdown separator so it can be concatenated before the prompt body', () => {
    const section = buildExtraHintsSection(['only']);
    expect(section.endsWith('---\n')).toBe(true);
  });

  it('trims surrounding whitespace from each hint', () => {
    const section = buildExtraHintsSection(['  padded hint  ', '\ttabbed\t']);
    expect(section).toContain('- padded hint');
    expect(section).toContain('- tabbed');
    expect(section).not.toContain('-   padded hint');
  });
});
