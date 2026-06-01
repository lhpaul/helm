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
  remediation: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
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
