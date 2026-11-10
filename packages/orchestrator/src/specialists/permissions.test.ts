import { describe, expect, it } from 'vitest';
import type { Product } from '@helm/shared';
import { GH_API_MUTATION_DENY_RULES, resolveSpecialistPermissions } from './permissions.js';
import { buildSpecWriterParams } from './spec-writer.js';
import { buildPlanWriterParams } from './plan-writer.js';

const make = (permissions?: unknown): Product =>
  ({
    product: { slug: 'p', name: 'P' },
    specialists: Object.fromEntries(
      ['spec-writer', 'plan-writer', 'implementer', 'code-reviewer'].map((id) => [
        id,
        id === 'spec-writer'
          ? { runtime: 'claude_code', model: 'm', permissions }
          : { runtime: 'claude_code', model: 'm' },
      ]),
    ),
  }) as unknown as Product;

describe('resolveSpecialistPermissions (#119)', () => {
  it('returns undefined when not configured', () => {
    expect(resolveSpecialistPermissions(make(), 'spec-writer')).toBeUndefined();
    expect(resolveSpecialistPermissions(make({}), 'spec-writer')).toBeUndefined();
  });

  it('maps add_dirs and allowed_tools', () => {
    expect(
      resolveSpecialistPermissions(
        make({ add_dirs: ['/ctx'], allowed_tools: ['Read'] }),
        'spec-writer',
      ),
    ).toEqual({ addDirs: ['/ctx'], allowedTools: ['Read'] });
  });

  it('gh_api_read_only allows gh api and denies every mutating form', () => {
    const out = resolveSpecialistPermissions(make({ gh_api_read_only: true }), 'spec-writer');
    expect(out?.allowedTools).toEqual(['Bash(gh api:*)']);
    expect(out?.disallowedTools).toEqual([...GH_API_MUTATION_DENY_RULES]);
    expect(out?.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(gh api graphql*)', 'Bash(gh api * -X*)']),
    );
  });

  it('does not copy gh mutation rules unless the product lists them', () => {
    const out = resolveSpecialistPermissions(make({ add_dirs: ['/ctx'] }), 'spec-writer');
    expect(out?.allowedTools).toBeUndefined();
  });

  it('flows into spec-writer params and stays absent for others', () => {
    const product = make({ add_dirs: ['/ctx'] });
    expect(buildSpecWriterParams('X-1', product, '/w').permissions).toEqual({ addDirs: ['/ctx'] });
    expect(buildPlanWriterParams('X-1', product, '/w', 'spec').permissions).toBeUndefined();
  });
});
