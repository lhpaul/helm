import { describe, expect, it } from 'vitest';
import { ProductSchema } from './product-schema.js';
import { ProductConfigError, parseProductConfig } from './product-parser.js';

// Raw product object with kebab-case specialist IDs (ADR-022 canonical form).
const makeRawProduct = (specialists: Record<string, unknown>) => ({
  helm_version: '0',
  product: { slug: 'test-product', name: 'Test Product' },
  issue_tracker: {
    provider: 'github_projects',
    org: 'test-org',
    project_number: 1,
  },
  code_repos: [{ url: 'https://github.com/test-org/test', default_branch: 'main', role: 'app' }],
  knowledge_repo: { url: 'https://github.com/test-org/knowledge', default_branch: 'main' },
  workflow: { stages_enabled: ['discovery', 'released'] },
  specialists,
});

const KEBAB_SPECIALISTS = {
  'spec-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  'plan-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
  'code-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  'security-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  'test-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  'spec-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  'plan-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
};

const SNAKE_SPECIALISTS = {
  spec_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  plan_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
  code_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  security_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  test_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  remediation: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
};

describe('ProductSchema — specialist ID naming (ADR-022)', () => {
  it('accepts kebab-case specialist IDs', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['spec-writer'].model).toBe('claude-sonnet-4-6');
      expect(result.data.specialists['code-reviewer'].runtime).toBe('claude_code');
    }
  });

  it('rejects snake_case specialist IDs at the schema level', () => {
    const result = ProductSchema.safeParse(makeRawProduct(SNAKE_SPECIALISTS));
    expect(result.success).toBe(false);
  });

  it('parseProductConfig surfaces an actionable kebab-case migration message', () => {
    const yaml = `
helm_version: "0"
product:
  slug: test-product
  name: Test Product
issue_tracker:
  provider: github_projects
  org: test-org
  project_number: 1
code_repos:
  - url: https://github.com/test-org/test-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/test-org/test-knowledge
  default_branch: main
workflow:
  stages_enabled: [discovery, released]
specialists:
  spec_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

    expect(() => parseProductConfig(yaml)).toThrow(ProductConfigError);
    expect(() => parseProductConfig(yaml)).toThrow('kebab-case');
    expect(() => parseProductConfig(yaml)).toThrow("'spec_writer' → 'spec-writer'");
  });

  it('does not misfire the legacy check on Object.prototype keys', () => {
    // The legacy-key detection uses hasOwnProperty, so a specialist literally
    // named e.g. "toString" must not be mistaken for a snake_case legacy key.
    const yaml = `
helm_version: "0"
product:
  slug: test-product
  name: Test Product
issue_tracker:
  provider: github_projects
  org: test-org
  project_number: 1
code_repos:
  - url: https://github.com/test-org/test-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/test-org/test-knowledge
  default_branch: main
workflow:
  stages_enabled: [discovery, released]
specialists:
  toString: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

    // It still fails (unknown specialist under .strict()), but NOT with the
    // kebab-case migration message — proving the prototype key didn't trip it.
    expect(() => parseProductConfig(yaml)).toThrow(ProductConfigError);
    expect(() => parseProductConfig(yaml)).not.toThrow('kebab-case');
  });
});

describe('ProductSchema — remediator specialists (ADR-024)', () => {
  it('accepts the 9-specialist kebab-case set including the remediators', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['spec-remediator'].model).toBe('claude-sonnet-4-6');
      expect(result.data.specialists['plan-remediator'].runtime).toBe('claude_code');
      expect(result.data.specialists['code-remediator'].model).toBe('claude-sonnet-4-6');
    }
  });

  it('rejects the product when a remediator entry is missing', () => {
    const withoutPlanRemediator: Record<string, unknown> = { ...KEBAB_SPECIALISTS };
    delete withoutPlanRemediator['plan-remediator'];
    const result = ProductSchema.safeParse(makeRawProduct(withoutPlanRemediator));
    expect(result.success).toBe(false);
  });

  it('rejects the legacy `remediation` key at the schema level (.strict())', () => {
    const rest: Record<string, unknown> = { ...KEBAB_SPECIALISTS };
    delete rest['code-remediator'];
    const legacy = { ...rest, remediation: { runtime: 'claude_code', model: 'claude-sonnet-4-6' } };
    const result = ProductSchema.safeParse(makeRawProduct(legacy));
    expect(result.success).toBe(false);
  });

  it('parseProductConfig surfaces an actionable `remediation` → `code-remediator` message', () => {
    const yaml = `
helm_version: "0"
product:
  slug: test-product
  name: Test Product
issue_tracker:
  provider: github_projects
  org: test-org
  project_number: 1
code_repos:
  - url: https://github.com/test-org/test-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/test-org/test-knowledge
  default_branch: main
workflow:
  stages_enabled: [discovery, released]
specialists:
  spec-writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  spec-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

    expect(() => parseProductConfig(yaml)).toThrow(ProductConfigError);
    // The `remediation` rename is a semantic ADR-024 change, NOT a kebab-case
    // fix — the message must reference ADR-024 and must not misframe it as kebab.
    expect(() => parseProductConfig(yaml)).toThrow('ADR-024');
    expect(() => parseProductConfig(yaml)).not.toThrow('kebab-case');
    expect(() => parseProductConfig(yaml)).toThrow("'remediation' → 'code-remediator'");
  });
});

describe('ProductSchema — extra_hints (ADR-023)', () => {
  const withHints = (hints: unknown) =>
    makeRawProduct({
      ...KEBAB_SPECIALISTS,
      'plan-writer': { ...KEBAB_SPECIALISTS['plan-writer'], extra_hints: hints },
    });

  it('parses when extra_hints is absent (field is optional)', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['plan-writer'].extra_hints).toBeUndefined();
    }
  });

  it('parses a single valid hint', () => {
    const result = ProductSchema.safeParse(withHints(['Pin exact runtime dep versions.']));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['plan-writer'].extra_hints).toEqual([
        'Pin exact runtime dep versions.',
      ]);
    }
  });

  it('parses 5 valid hints preserving order', () => {
    const hints = ['one', 'two', 'three', 'four', 'five'];
    const result = ProductSchema.safeParse(withHints(hints));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['plan-writer'].extra_hints).toEqual(hints);
    }
  });

  it('parses exactly 20 hints (upper bound)', () => {
    const hints = Array.from({ length: 20 }, (_, i) => `hint ${i + 1}`);
    const result = ProductSchema.safeParse(withHints(hints));
    expect(result.success).toBe(true);
  });

  it('rejects an empty-string hint', () => {
    const result = ProductSchema.safeParse(withHints(['valid', '']));
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only hint', () => {
    const result = ProductSchema.safeParse(withHints(['   \t\n  ']));
    expect(result.success).toBe(false);
  });

  it('stores hints trimmed of surrounding whitespace', () => {
    const result = ProductSchema.safeParse(withHints(['  padded hint  ']));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['plan-writer'].extra_hints).toEqual(['padded hint']);
    }
  });

  it('rejects a hint longer than 500 chars', () => {
    const result = ProductSchema.safeParse(withHints(['x'.repeat(501)]));
    expect(result.success).toBe(false);
  });

  it('accepts a hint of exactly 500 chars', () => {
    const result = ProductSchema.safeParse(withHints(['x'.repeat(500)]));
    expect(result.success).toBe(true);
  });

  it('rejects more than 20 hints', () => {
    const hints = Array.from({ length: 21 }, (_, i) => `hint ${i + 1}`);
    const result = ProductSchema.safeParse(withHints(hints));
    expect(result.success).toBe(false);
  });
});

describe('ProductSchema — readiness_gate (ADR-026)', () => {
  const withReadinessGate = (gate: unknown) => ({
    ...makeRawProduct(KEBAB_SPECIALISTS),
    workflow: { stages_enabled: ['discovery', 'released'], readiness_gate: gate },
  });

  it('defaults readiness_gate to skip when omitted', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.workflow.readiness_gate).toBe('skip');
  });

  it('accepts explicit warn and required', () => {
    for (const gate of ['warn', 'required'] as const) {
      const result = ProductSchema.safeParse(withReadinessGate(gate));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.workflow.readiness_gate).toBe(gate);
    }
  });

  it('rejects an unknown readiness_gate value', () => {
    const result = ProductSchema.safeParse(withReadinessGate('block'));
    expect(result.success).toBe(false);
  });
});

describe('ProductSchema — final_stage (ADR-032)', () => {
  const withFinalStage = (finalStage: unknown) => ({
    ...makeRawProduct(KEBAB_SPECIALISTS),
    workflow: { stages_enabled: ['discovery', 'released'], final_stage: finalStage },
  });

  it('defaults final_stage to released when omitted', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.workflow.final_stage).toBe('released');
  });

  it('accepts explicit merged and released', () => {
    for (const stage of ['merged', 'released'] as const) {
      const result = ProductSchema.safeParse(withFinalStage(stage));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.workflow.final_stage).toBe(stage);
    }
  });

  it('rejects a final_stage value outside the enum (e.g. a mid-workflow stage)', () => {
    const result = ProductSchema.safeParse(withFinalStage('code-review'));
    expect(result.success).toBe(false);
  });
});

describe('ProductSchema — native_state_map (ADR-035)', () => {
  const withNativeStateMap = (map: unknown) => ({
    ...makeRawProduct(KEBAB_SPECIALISTS),
    workflow: { stages_enabled: ['discovery', 'released'], native_state_map: map },
  });

  it('is optional — a product without a native_state_map parses (backward compatible)', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.workflow.native_state_map).toBeUndefined();
  });

  it('parses a map of workflow stages to non-empty state ids', () => {
    const map = { merged: 'state-merged-uuid', released: 'state-released-uuid' };
    const result = ProductSchema.safeParse(withNativeStateMap(map));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.workflow.native_state_map).toEqual(map);
  });

  it('allows mapping any stage, not just merged/released', () => {
    const map = { 'code-review': 'state-in-review', 'in-development': 'state-in-dev' };
    const result = ProductSchema.safeParse(withNativeStateMap(map));
    expect(result.success).toBe(true);
  });

  it('rejects a key that is not a known workflow stage', () => {
    const result = ProductSchema.safeParse(withNativeStateMap({ 'not-a-stage': 'state-uuid' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string state id', () => {
    const result = ProductSchema.safeParse(withNativeStateMap({ merged: '' }));
    expect(result.success).toBe(false);
  });
});

describe('ProductSchema — review loop (ADR-036)', () => {
  const withReview = (review: unknown) => ({
    ...makeRawProduct(KEBAB_SPECIALISTS),
    review,
  });

  it('is optional — products without review parse', () => {
    const result = ProductSchema.safeParse(makeRawProduct(KEBAB_SPECIALISTS));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.review).toBeUndefined();
  });

  it('parses external haystack provider, loop overrides, and adjudication config', () => {
    const result = ProductSchema.safeParse(
      withReview({
        external: { provider: 'haystack', haystack: { major_is_blocking: true } },
        loop: {
          max_cycles: 3,
          adjudication: { enabled: false },
          stop_rule: { no_progress_cycles: 4 },
        },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review?.external?.provider).toBe('haystack');
      expect(result.data.review?.loop?.max_cycles).toBe(3);
      expect(result.data.review?.loop?.adjudication?.enabled).toBe(false);
    }
  });

  it('parses optional review-adjudicator specialist (ADR-037)', () => {
    const result = ProductSchema.safeParse({
      ...makeRawProduct({
        ...KEBAB_SPECIALISTS,
        'review-adjudicator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      }),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists['review-adjudicator']?.model).toBe('claude-sonnet-4-6');
    }
  });

  it('rejects unknown external providers', () => {
    const result = ProductSchema.safeParse(withReview({ external: { provider: 'coderabbit' } }));
    expect(result.success).toBe(false);
  });

  it('rejects non-positive max_cycles', () => {
    const result = ProductSchema.safeParse(withReview({ loop: { max_cycles: 0 } }));
    expect(result.success).toBe(false);
  });

  it('rejects non-positive no_progress_cycles', () => {
    const result = ProductSchema.safeParse(
      withReview({ loop: { stop_rule: { no_progress_cycles: 0 } } }),
    );
    expect(result.success).toBe(false);
  });

  it('applies ADR-036 defaults for haystack and stop_rule when fields are omitted', () => {
    const result = ProductSchema.safeParse(
      withReview({
        external: { provider: 'haystack', haystack: {} },
        loop: { stop_rule: {} },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review?.external?.haystack).toEqual({
        major_is_blocking: false,
        poll_interval_sec: 15,
        timeout_sec: 120,
      });
      expect(result.data.review?.loop?.max_cycles).toBe(5);
      expect(result.data.review?.loop?.stop_rule?.no_progress_cycles).toBe(2);
    }
  });

  it('rejects unknown keys in review.external.haystack', () => {
    const result = ProductSchema.safeParse(
      withReview({
        external: { provider: 'haystack', haystack: { unknown_flag: true } },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in review.loop.stop_rule', () => {
    const result = ProductSchema.safeParse(
      withReview({
        loop: { stop_rule: { no_progress_cycles: 2, unknown_flag: true } },
      }),
    );
    expect(result.success).toBe(false);
  });
});
