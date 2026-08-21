import { describe, expect, it, vi } from 'vitest';

import {
  formatContractValidationScopeBlock,
  formatSubsequentReviewPassBlock,
  isContractValidationPath,
  listPullRequestChangedPaths,
  parsePullRequestUrl,
  selectContractValidationFiles,
  suppressOffDiffContractDrift,
} from './contract-validation-scope.js';

describe('isContractValidationPath', () => {
  it('matches schema dirs, migrations, and sql files', () => {
    expect(
      isContractValidationPath('packages/db/src/schema/core-common-expenses-snapshots.ts'),
    ).toBe(true);
    expect(isContractValidationPath('packages/db/migrations/0001_core_mirror.sql')).toBe(true);
    expect(isContractValidationPath('db/migration/add_foo.sql')).toBe(true);
    expect(isContractValidationPath('schema.sql')).toBe(true);
  });

  it('does not match application auth/session files (LEA-110)', () => {
    expect(isContractValidationPath('apps/api/src/lib/auth.ts')).toBe(false);
    expect(isContractValidationPath('apps/api/src/lib/trusted-origin.ts')).toBe(false);
    expect(isContractValidationPath('apps/mobile/lib/auth/client.ts')).toBe(false);
    expect(isContractValidationPath('apps/mobile/test/auth-client.test.ts')).toBe(false);
  });
});

describe('selectContractValidationFiles', () => {
  it('returns unique matching paths only', () => {
    expect(
      selectContractValidationFiles([
        'apps/api/src/lib/auth.ts',
        'packages/db/src/schema/tenants.ts',
        'packages/db/src/schema/tenants.ts',
        'apps/api/test/auth.test.ts',
      ]),
    ).toEqual(['packages/db/src/schema/tenants.ts']);
  });
});

describe('parsePullRequestUrl', () => {
  it('parses owner/repo/number', () => {
    expect(parsePullRequestUrl('https://github.com/lhpaul/leasity-tenants/pull/18')).toEqual({
      owner: 'lhpaul',
      repo: 'leasity-tenants',
      number: '18',
    });
  });

  it('returns null for non-PR URLs', () => {
    expect(parsePullRequestUrl('https://github.com/lhpaul/leasity-tenants')).toBeNull();
  });
});

describe('listPullRequestChangedPaths', () => {
  it('reads paginated filenames from gh', async () => {
    const runGh = vi.fn().mockResolvedValue({
      stdout: 'apps/api/src/lib/auth.ts\npackages/db/src/schema/foo.ts\n',
    });
    await expect(
      listPullRequestChangedPaths('https://github.com/o/r/pull/1', 'tok', runGh),
    ).resolves.toEqual(['apps/api/src/lib/auth.ts', 'packages/db/src/schema/foo.ts']);
    expect(runGh).toHaveBeenCalledWith(
      ['api', '--paginate', 'repos/o/r/pulls/1/files', '--jq', '.[].filename'],
      { env: { GITHUB_TOKEN: 'tok' } },
    );
  });
});

describe('formatContractValidationScopeBlock', () => {
  it('keeps the prose gate when the file list was not computed', () => {
    const block = formatContractValidationScopeBlock(undefined);
    expect(block).toContain('Scope gate:');
    expect(block).not.toContain('computed');
  });

  it('forbids §4 audit when the computed list is empty', () => {
    const block = formatContractValidationScopeBlock([]);
    expect(block).toContain('Schema files in this diff: none');
    expect(block).toContain('Do **not** emit any `Contract drift §4` finding');
  });

  it('lists only the schema files when present', () => {
    const block = formatContractValidationScopeBlock(['packages/db/src/schema/foo.ts']);
    expect(block).toContain('`packages/db/src/schema/foo.ts`');
    expect(block).toContain('validate only these');
  });
});

describe('formatSubsequentReviewPassBlock', () => {
  it('always requires diff-cited HIGH/MEDIUM', () => {
    const first = formatSubsequentReviewPassBlock(false);
    expect(first).toContain('HIGH and MEDIUM findings must cite a path');
    expect(first).not.toContain('Subsequent review pass');
  });

  it('freezes new quality themes after the first pass', () => {
    const later = formatSubsequentReviewPassBlock(true);
    expect(later).toContain('Subsequent review pass');
    expect(later).toContain('brand-new quality theme');
  });
});

describe('suppressOffDiffContractDrift', () => {
  const findings = { critical: 0, high: 1, medium: 0, low: 0, info: 0 };
  const body = [
    '# Code Review',
    '',
    '## Findings',
    '- **HIGH** · Contract drift §4 · core_common_expenses_snapshots.pending_amount_clp',
    '',
    '## Status',
    'CHANGES_REQUESTED',
  ].join('\n');

  it('is a no-op when the file list is unknown or non-empty', () => {
    expect(suppressOffDiffContractDrift(body, findings, undefined)).toEqual({
      reviewContent: body,
      findings,
    });
    expect(suppressOffDiffContractDrift(body, findings, ['packages/db/src/schema/foo.ts'])).toEqual(
      { reviewContent: body, findings },
    );
  });

  it('demotes HIGH contract-drift and flips APPROVED when the diff has no schema files', () => {
    const result = suppressOffDiffContractDrift(body, findings, []);
    expect(result.findings).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 1 });
    expect(result.reviewContent).toContain('**INFO** · Off-diff contract drift (suppressed):');
    expect(result.reviewContent).toMatch(/## Status\s*\nAPPROVED/);
  });
});
