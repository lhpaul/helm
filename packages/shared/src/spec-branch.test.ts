import { describe, expect, it } from 'vitest';
import {
  SPEC_BRANCH_PREFIX,
  specBranchName,
  PLAN_BRANCH_PREFIX,
  planBranchName,
  IMPL_BRANCH_PREFIX,
  implBranchName,
  parseArtifactBranch,
} from './spec-branch.js';

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

describe('PLAN_BRANCH_PREFIX', () => {
  it('is helm/plan/', () => {
    expect(PLAN_BRANCH_PREFIX).toBe('helm/plan/');
  });
});

describe('planBranchName', () => {
  it('prepends helm/plan/ to the externalId', () => {
    expect(planBranchName('HLM-42')).toBe('helm/plan/HLM-42');
    expect(planBranchName('issue_1')).toBe('helm/plan/issue_1');
    expect(planBranchName('feature.v2')).toBe('helm/plan/feature.v2');
  });

  it('produces a different branch than specBranchName for the same id', () => {
    expect(planBranchName('HLM-42')).not.toBe(specBranchName('HLM-42'));
    expect(planBranchName('HLM-42')).toBe('helm/plan/HLM-42');
    expect(specBranchName('HLM-42')).toBe('helm/spec/HLM-42');
  });
});

describe('IMPL_BRANCH_PREFIX', () => {
  it('is helm/impl/', () => {
    expect(IMPL_BRANCH_PREFIX).toBe('helm/impl/');
  });
});

describe('implBranchName', () => {
  it('prepends helm/impl/ to the externalId', () => {
    expect(implBranchName('HLM-42')).toBe('helm/impl/HLM-42');
    expect(implBranchName('issue_1')).toBe('helm/impl/issue_1');
    expect(implBranchName('feature.v2')).toBe('helm/impl/feature.v2');
  });

  it('produces a different branch than specBranchName and planBranchName for the same id', () => {
    expect(implBranchName('HLM-42')).not.toBe(specBranchName('HLM-42'));
    expect(implBranchName('HLM-42')).not.toBe(planBranchName('HLM-42'));
    expect(implBranchName('HLM-42')).toBe('helm/impl/HLM-42');
  });
});

describe('parseArtifactBranch', () => {
  // ── Spec branches ──────────────────────────────────────────────────────────

  it('returns { kind: spec, externalId } for a standard spec branch', () => {
    expect(parseArtifactBranch('helm/spec/HLM-42')).toEqual({ kind: 'spec', externalId: 'HLM-42' });
    expect(parseArtifactBranch('helm/spec/issue_1')).toEqual({
      kind: 'spec',
      externalId: 'issue_1',
    });
    expect(parseArtifactBranch('helm/spec/feature.v2')).toEqual({
      kind: 'spec',
      externalId: 'feature.v2',
    });
  });

  // ── Impl branches ──────────────────────────────────────────────────────────

  it('returns { kind: impl, externalId } for a standard impl branch', () => {
    expect(parseArtifactBranch('helm/impl/HLM-42')).toEqual({ kind: 'impl', externalId: 'HLM-42' });
    expect(parseArtifactBranch('helm/impl/issue_1')).toEqual({
      kind: 'impl',
      externalId: 'issue_1',
    });
    expect(parseArtifactBranch('helm/impl/feature.v2')).toEqual({
      kind: 'impl',
      externalId: 'feature.v2',
    });
  });

  // ── Plan branches ──────────────────────────────────────────────────────────

  it('returns { kind: plan, externalId } for a standard plan branch', () => {
    expect(parseArtifactBranch('helm/plan/HLM-42')).toEqual({ kind: 'plan', externalId: 'HLM-42' });
    expect(parseArtifactBranch('helm/plan/issue_1')).toEqual({
      kind: 'plan',
      externalId: 'issue_1',
    });
    expect(parseArtifactBranch('helm/plan/feature.v2')).toEqual({
      kind: 'plan',
      externalId: 'feature.v2',
    });
  });

  // ── Non-artifact branches ──────────────────────────────────────────────────

  it('returns null for non-artifact branches', () => {
    expect(parseArtifactBranch('feature/foo')).toBeNull();
    expect(parseArtifactBranch('main')).toBeNull();
    expect(parseArtifactBranch('')).toBeNull();
  });

  // ── Traversal / injection guards ──────────────────────────────────────────

  it('returns null for dot-segment traversal attempts in spec branches', () => {
    expect(parseArtifactBranch('helm/spec/../x')).toBeNull();
    expect(parseArtifactBranch('helm/spec/.')).toBeNull();
    expect(parseArtifactBranch('helm/spec/..')).toBeNull();
  });

  it('returns null for dot-segment traversal attempts in plan branches', () => {
    expect(parseArtifactBranch('helm/plan/../x')).toBeNull();
    expect(parseArtifactBranch('helm/plan/.')).toBeNull();
    expect(parseArtifactBranch('helm/plan/..')).toBeNull();
  });

  it('returns null for dot-segment traversal attempts in impl branches', () => {
    expect(parseArtifactBranch('helm/impl/../x')).toBeNull();
    expect(parseArtifactBranch('helm/impl/.')).toBeNull();
    expect(parseArtifactBranch('helm/impl/..')).toBeNull();
  });

  it('returns null for dot-prefixed externalIds (hidden-file style)', () => {
    expect(parseArtifactBranch('helm/spec/.hidden')).toBeNull();
    expect(parseArtifactBranch('helm/plan/.hidden')).toBeNull();
    expect(parseArtifactBranch('helm/impl/.hidden')).toBeNull();
  });

  it('returns null for externalIds with disallowed characters', () => {
    // slash — path traversal
    expect(parseArtifactBranch('helm/spec/foo/bar')).toBeNull();
    expect(parseArtifactBranch('helm/plan/foo/bar')).toBeNull();
    expect(parseArtifactBranch('helm/impl/foo/bar')).toBeNull();
    // space
    expect(parseArtifactBranch('helm/spec/foo bar')).toBeNull();
    // empty suffix
    expect(parseArtifactBranch('helm/spec/')).toBeNull();
    expect(parseArtifactBranch('helm/plan/')).toBeNull();
    expect(parseArtifactBranch('helm/impl/')).toBeNull();
  });

  // ── Inverse property ──────────────────────────────────────────────────────

  it('is the inverse of specBranchName for valid externalIds', () => {
    const ids = ['HLM-42', 'issue_1', 'feature.v2', 'my-item'];
    for (const id of ids) {
      const parsed = parseArtifactBranch(specBranchName(id));
      expect(parsed).toEqual({ kind: 'spec', externalId: id });
    }
  });

  it('is the inverse of planBranchName for valid externalIds', () => {
    const ids = ['HLM-42', 'issue_1', 'feature.v2', 'my-item'];
    for (const id of ids) {
      const parsed = parseArtifactBranch(planBranchName(id));
      expect(parsed).toEqual({ kind: 'plan', externalId: id });
    }
  });

  it('is the inverse of implBranchName for valid externalIds', () => {
    const ids = ['HLM-42', 'issue_1', 'feature.v2', 'my-item'];
    for (const id of ids) {
      const parsed = parseArtifactBranch(implBranchName(id));
      expect(parsed).toEqual({ kind: 'impl', externalId: id });
    }
  });
});
