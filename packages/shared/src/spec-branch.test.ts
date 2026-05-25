import { describe, expect, it } from 'vitest';
import { SPEC_BRANCH_PREFIX, specBranchName, parseSpecBranch } from './spec-branch.js';

describe('SPEC_BRANCH_PREFIX', () => {
  it('is helm/spec/', () => {
    expect(SPEC_BRANCH_PREFIX).toBe('helm/spec/');
  });
});

describe('specBranchName', () => {
  it('prepends helm/spec/ to the externalId', () => {
    expect(specBranchName('HLM-42')).toBe('helm/spec/HLM-42');
    expect(specBranchName('issue_1')).toBe('helm/spec/issue_1');
    expect(specBranchName('feature.v2')).toBe('helm/spec/feature.v2');
  });
});

describe('parseSpecBranch', () => {
  it('returns externalId for a standard spec branch', () => {
    expect(parseSpecBranch('helm/spec/HLM-42')).toBe('HLM-42');
    expect(parseSpecBranch('helm/spec/issue_1')).toBe('issue_1');
    expect(parseSpecBranch('helm/spec/feature.v2')).toBe('feature.v2');
  });

  it('returns null for non-spec branches', () => {
    expect(parseSpecBranch('feature/foo')).toBeNull();
    expect(parseSpecBranch('main')).toBeNull();
    expect(parseSpecBranch('helm/plan/HLM-42')).toBeNull();
    expect(parseSpecBranch('')).toBeNull();
  });

  it('returns null for dot-segment traversal attempts', () => {
    // helm/spec/../x — the suffix is '../x' which starts with '.'
    expect(parseSpecBranch('helm/spec/../x')).toBeNull();
    // helm/spec/. — suffix is '.' (single dot)
    expect(parseSpecBranch('helm/spec/.')).toBeNull();
    // helm/spec/.. — suffix is '..' (double dot)
    expect(parseSpecBranch('helm/spec/..')).toBeNull();
  });

  it('returns null for dot-prefixed externalIds (hidden-file style)', () => {
    expect(parseSpecBranch('helm/spec/.hidden')).toBeNull();
  });

  it('returns null for externalIds with disallowed characters', () => {
    // slash — path traversal
    expect(parseSpecBranch('helm/spec/foo/bar')).toBeNull();
    // space
    expect(parseSpecBranch('helm/spec/foo bar')).toBeNull();
    // empty suffix
    expect(parseSpecBranch('helm/spec/')).toBeNull();
  });

  it('is the inverse of specBranchName for valid externalIds', () => {
    const ids = ['HLM-42', 'issue_1', 'feature.v2', 'my-item'];
    for (const id of ids) {
      expect(parseSpecBranch(specBranchName(id))).toBe(id);
    }
  });
});
