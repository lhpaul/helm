import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProductConfigError, parseProductConfig } from './product-parser.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');

// Minimal valid configs for schema-default tests — inline to avoid fixture proliferation.
// These exist only to test Zod default() behaviour; not representative of real configs.
const GITHUB_WITHOUT_CUSTOM_FIELD = `
helm_version: "0"
product:
  slug: test-defaults
  name: Test Defaults
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
  stages_enabled: [in-development, released]
specialists:
  spec_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

const LINEAR_WITHOUT_LABEL_PREFIX = `
helm_version: "0"
product:
  slug: test-defaults
  name: Test Defaults
issue_tracker:
  provider: linear
  workspace: test-workspace
  team_key: TEST
code_repos:
  - url: https://github.com/test-org/test-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/test-org/test-knowledge
  default_branch: main
workflow:
  stages_enabled: [in-development, released]
specialists:
  spec_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

describe('parseProductConfig', () => {
  describe('valid configs', () => {
    it('parses GitHub Projects provider with single repo', () => {
      const config = parseProductConfig(fixture('valid-github-projects.yaml'));

      expect(config.product.slug).toBe('example-app');
      expect(config.issue_tracker.provider).toBe('github_projects');
      expect(config.code_repos).toHaveLength(1);
      expect(config.code_repos[0]?.role).toBe('app');
      expect(config.workflow.designer_gate).toBe('skip');
      expect(config.workflow.qa_gate).toBe('skip');
    });

    it('parses Linear provider with multi-repo and validates discriminated union', () => {
      const config = parseProductConfig(fixture('valid-linear-multi-repo.yaml'));

      expect(config.product.slug).toBe('acme-platform');
      expect(config.issue_tracker.provider).toBe('linear');
      // type-narrowing via discriminated union — TypeScript enforces this at compile time
      if (config.issue_tracker.provider === 'linear') {
        expect(config.issue_tracker.team_key).toBe('ACME');
        expect(config.issue_tracker.label_prefix).toBe('helm:');
      }
      expect(config.code_repos).toHaveLength(2);
      expect(config.code_repos[1]?.role).toBe('docs');
    });

    it('parses optional notifications block', () => {
      const config = parseProductConfig(fixture('valid-github-projects-with-notifications.yaml'));

      expect(config.notifications).toBeDefined();
      expect(config.notifications?.slack_webhook).toBe(
        'https://hooks.slack.com/services/TXXXXX/BXXXXX/dummy',
      );
    });
  });

  describe('default values', () => {
    it('defaults custom_field_name to "Helm Stage" when omitted (github_projects)', () => {
      const config = parseProductConfig(GITHUB_WITHOUT_CUSTOM_FIELD);

      expect(config.issue_tracker.provider).toBe('github_projects');
      if (config.issue_tracker.provider === 'github_projects') {
        expect(config.issue_tracker.custom_field_name).toBe('Helm Stage');
      }
    });

    it('defaults label_prefix to "helm:" when omitted (linear)', () => {
      const config = parseProductConfig(LINEAR_WITHOUT_LABEL_PREFIX);

      expect(config.issue_tracker.provider).toBe('linear');
      if (config.issue_tracker.provider === 'linear') {
        expect(config.issue_tracker.label_prefix).toBe('helm:');
      }
    });
  });

  describe('invalid configs', () => {
    it('throws ProductConfigError with issue_tracker path on unknown provider', () => {
      expect(() => parseProductConfig(fixture('invalid-provider.yaml'))).toThrow(
        ProductConfigError,
      );
      expect(() => parseProductConfig(fixture('invalid-provider.yaml'))).toThrow('issue_tracker');
    });

    it('throws ProductConfigError with code_repos path on empty repos array', () => {
      expect(() => parseProductConfig(fixture('invalid-empty-repos.yaml'))).toThrow(
        ProductConfigError,
      );
      expect(() => parseProductConfig(fixture('invalid-empty-repos.yaml'))).toThrow('code_repos');
    });

    it('throws ProductConfigError with product.slug path on invalid slug', () => {
      expect(() => parseProductConfig(fixture('invalid-slug.yaml'))).toThrow(ProductConfigError);
      expect(() => parseProductConfig(fixture('invalid-slug.yaml'))).toThrow('product.slug');
    });

    it('throws ProductConfigError with runtime path on unsupported runtime', () => {
      expect(() => parseProductConfig(fixture('invalid-runtime.yaml'))).toThrow(ProductConfigError);
      expect(() => parseProductConfig(fixture('invalid-runtime.yaml'))).toThrow('runtime');
    });
  });
});
