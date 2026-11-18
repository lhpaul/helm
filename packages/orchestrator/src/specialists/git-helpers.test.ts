import { describe, expect, it } from 'vitest';
import { buildAuthenticatedUrl, sanitizeToken } from './git-helpers.js';

// ── buildAuthenticatedUrl ─────────────────────────────────────────────────────

describe('buildAuthenticatedUrl', () => {
  it('embeds the token as x-access-token basic-auth credentials', () => {
    const url = buildAuthenticatedUrl('my-org', 'my-repo', 'ghp_abc123');
    expect(url).toBe('https://x-access-token:ghp_abc123@github.com/my-org/my-repo');
  });

  it('URL does not contain the token in plain form (token is in credentials section)', () => {
    const url = buildAuthenticatedUrl('org', 'repo', 'secret-tok');
    expect(url).toContain('x-access-token:secret-tok@');
    expect(url).toContain('github.com/org/repo');
  });
});

// ── sanitizeToken ─────────────────────────────────────────────────────────────

describe('sanitizeToken', () => {
  it('redacts a single URL-embedded occurrence', () => {
    const token = 'ghp_secret';
    const input = `fatal: could not read from x-access-token:${token}@github.com/org/repo`;
    const result = sanitizeToken(input, token);
    expect(result).not.toContain(token);
    expect(result).toContain('x-access-token:***@github.com/org/repo');
  });

  it('redacts the bare token occurrence', () => {
    const token = 'ghp_secret';
    const input = `Error: token=${token} is invalid`;
    const result = sanitizeToken(input, token);
    expect(result).not.toContain(token);
    expect(result).toContain('***');
  });

  it('redacts ALL occurrences when the token appears multiple times in the same string', () => {
    const token = 'tok-multi';
    // Simulates a git error that echoes the URL twice (e.g. in a trace + message)
    const input =
      `remote: Invalid credentials x-access-token:${token}@github.com ` +
      `(also seen: x-access-token:${token}@github.com) raw=${token}`;
    const result = sanitizeToken(input, token);
    expect(result).not.toContain(token);
    // Both URL occurrences replaced
    expect(result).toContain('x-access-token:***@github.com');
    // Bare token also replaced
    expect(result).toContain('raw=***');
    // Should appear 2 times for the URL pattern + 1 for the bare raw= occurrence
    const redacted = result.match(/\*\*\*/g) ?? [];
    expect(redacted.length).toBeGreaterThanOrEqual(3);
  });

  it('returns the string unchanged when the token does not appear', () => {
    const result = sanitizeToken('no credentials here', 'some-token');
    expect(result).toBe('no credentials here');
  });
});
