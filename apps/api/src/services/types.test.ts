import { describe, expect, it } from 'vitest';
import { isSafeFsPath } from './types.js';

describe('isSafeFsPath', () => {
  it('accepts ordinary absolute and relative directory paths', () => {
    expect(isSafeFsPath('/Users/me/Git/helm-knowledge')).toBe(true);
    expect(isSafeFsPath('data')).toBe(true);
    expect(isSafeFsPath('var/data/items')).toBe(true);
    expect(isSafeFsPath('my-repo.v2')).toBe(true);
  });

  it('rejects values with characters outside the allowlist', () => {
    expect(isSafeFsPath('/tmp/with space')).toBe(false);
    expect(isSafeFsPath('repo;rm -rf')).toBe(false);
    expect(isSafeFsPath('repo$(whoami)')).toBe(false);
    expect(isSafeFsPath('')).toBe(false);
  });

  it("rejects '.' and '..' path segments (traversal / ambiguous CWD)", () => {
    expect(isSafeFsPath('..')).toBe(false);
    expect(isSafeFsPath('../sibling')).toBe(false);
    expect(isSafeFsPath('/abs/../escape')).toBe(false);
    expect(isSafeFsPath('./data')).toBe(false);
    expect(isSafeFsPath('a/./b')).toBe(false);
  });

  it('does not reject dots that are not whole segments', () => {
    // A leading-dot dir or dotted filename is fine — only '.'/'..' segments are blocked.
    expect(isSafeFsPath('.helm')).toBe(true);
    expect(isSafeFsPath('repo/.config/x')).toBe(true);
  });
});
