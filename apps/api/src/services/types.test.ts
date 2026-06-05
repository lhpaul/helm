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
    // Backslash traversal, tilde expansion, Windows drive paths, and null bytes
    // all contain characters outside the allowlist.
    expect(isSafeFsPath('data\\..\\escape')).toBe(false);
    expect(isSafeFsPath('~/data')).toBe(false);
    expect(isSafeFsPath('C:\\Users\\admin')).toBe(false);
    expect(isSafeFsPath('data\0/etc/passwd')).toBe(false);
  });

  it("rejects '.' and '..' path segments (traversal / ambiguous CWD)", () => {
    expect(isSafeFsPath('.')).toBe(false);
    expect(isSafeFsPath('..')).toBe(false);
    expect(isSafeFsPath('../sibling')).toBe(false);
    expect(isSafeFsPath('/abs/../escape')).toBe(false);
    expect(isSafeFsPath('./data')).toBe(false);
    expect(isSafeFsPath('a/./b')).toBe(false);
  });

  it('rejects the bare root and empty (consecutive/trailing) segments', () => {
    expect(isSafeFsPath('/')).toBe(false);
    expect(isSafeFsPath('//')).toBe(false);
    expect(isSafeFsPath('a//b')).toBe(false);
    expect(isSafeFsPath('data/')).toBe(false);
  });

  it('allows the single leading slash of an absolute path', () => {
    expect(isSafeFsPath('/var/lib/helm/data')).toBe(true);
    expect(isSafeFsPath('/opt/helm-knowledge')).toBe(true);
  });

  it('does not reject dots that are not whole "." or ".." segments', () => {
    // A leading-dot dir, dotted filename, or run of dots within a segment is fine
    // — only exact '.'/'..' segments are traversal and get blocked.
    expect(isSafeFsPath('.helm')).toBe(true);
    expect(isSafeFsPath('repo/.config/x')).toBe(true);
    expect(isSafeFsPath('...')).toBe(true);
    expect(isSafeFsPath('a..b')).toBe(true);
  });
});
