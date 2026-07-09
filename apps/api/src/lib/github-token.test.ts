import { afterEach, describe, expect, it } from 'vitest';

import { readGitHubTokenFromEnv } from './github-token.js';

describe('readGitHubTokenFromEnv', () => {
  const saved = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  });

  it('returns undefined when GITHUB_TOKEN is unset', () => {
    delete process.env.GITHUB_TOKEN;
    expect(readGitHubTokenFromEnv()).toBeUndefined();
  });

  it('trims whitespace from GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = '  token-value  ';
    expect(readGitHubTokenFromEnv()).toBe('token-value');
  });
});
