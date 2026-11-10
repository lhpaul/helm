import { describe, expect, it } from 'vitest';
import type { Product } from '@helm/shared';
import { resolveSpecialistTimeoutMs } from './timeout.js';
import { buildSpecWriterParams } from './spec-writer.js';
import { buildPlanWriterParams } from './plan-writer.js';

const specialist = { runtime: 'claude_code' as const, model: 'm' };

const makeProduct = (overrides: Record<string, number> = {}): Product =>
  ({
    product: { slug: 'p', name: 'P' },
    specialists: Object.fromEntries(
      [
        'spec-writer',
        'plan-writer',
        'implementer',
        'code-reviewer',
        'security-reviewer',
        'test-reviewer',
        'spec-remediator',
        'plan-remediator',
        'code-remediator',
      ].map((id) => [
        id,
        overrides[id] !== undefined ? { ...specialist, timeout_sec: overrides[id] } : specialist,
      ]),
    ),
  }) as unknown as Product;

describe('resolveSpecialistTimeoutMs (#118)', () => {
  it('returns the fallback when timeout_sec is not configured', () => {
    expect(resolveSpecialistTimeoutMs(makeProduct(), 'implementer', 1234)).toBe(1234);
  });

  it('returns undefined without fallback so the runtime default applies', () => {
    expect(resolveSpecialistTimeoutMs(makeProduct(), 'spec-writer')).toBeUndefined();
  });

  it('converts configured seconds to ms and overrides the fallback', () => {
    const product = makeProduct({ implementer: 3600 });
    expect(resolveSpecialistTimeoutMs(product, 'implementer', 1234)).toBe(3_600_000);
  });
});

describe('writer spawn params honour timeout_sec (#118)', () => {
  it('spec-writer: leaves timeoutMs undefined by default (runtime default)', () => {
    expect(buildSpecWriterParams('issue_1', makeProduct(), '/w').timeoutMs).toBeUndefined();
  });

  it('spec-writer: passes configured timeout beyond the 5 min runtime default', () => {
    const params = buildSpecWriterParams('issue_1', makeProduct({ 'spec-writer': 1200 }), '/w');
    expect(params.timeoutMs).toBe(1_200_000);
  });

  it('plan-writer: leaves timeoutMs undefined by default', () => {
    expect(buildPlanWriterParams('issue_1', makeProduct(), '/w', 'spec').timeoutMs).toBeUndefined();
  });

  it('plan-writer: passes configured timeout', () => {
    const params = buildPlanWriterParams(
      'issue_1',
      makeProduct({ 'plan-writer': 1800 }),
      '/w',
      'spec',
    );
    expect(params.timeoutMs).toBe(1_800_000);
  });
});
