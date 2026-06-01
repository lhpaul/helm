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
});
