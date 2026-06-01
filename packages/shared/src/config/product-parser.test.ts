import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ProductConfigError,
  parseProductConfig,
  parseProductConfigFromFile,
} from './product-parser.js';

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
  spec-writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  spec-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  code-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

const LINEAR_VALID = `
helm_version: "0"
product:
  slug: test-defaults
  name: Test Defaults
issue_tracker:
  provider: linear
  api_key_env: LINEAR_API_KEY
  team_key: TEST
  webhook_secret_env: LINEAR_WEBHOOK_SECRET
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
  spec-writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test-reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  spec-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  code-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

// Builds a config with per-specialist runtimes so we can exercise the
// "all specialists share one runtime" superRefine (H1 constraint, see ADR-021).
const specialistsBlock = (runtimes: {
  'spec-writer'?: string;
  'plan-writer'?: string;
  implementer?: string;
  'code-reviewer'?: string;
  'security-reviewer'?: string;
  'test-reviewer'?: string;
  'spec-remediator'?: string;
  'plan-remediator'?: string;
  'code-remediator'?: string;
}): string => {
  const r = {
    'spec-writer': 'claude_code',
    'plan-writer': 'claude_code',
    implementer: 'claude_code',
    'code-reviewer': 'claude_code',
    'security-reviewer': 'claude_code',
    'test-reviewer': 'claude_code',
    'spec-remediator': 'claude_code',
    'plan-remediator': 'claude_code',
    'code-remediator': 'claude_code',
    ...runtimes,
  };
  return `
helm_version: "0"
product:
  slug: test-runtimes
  name: Test Runtimes
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
  spec-writer: { runtime: ${r['spec-writer']}, model: m }
  plan-writer: { runtime: ${r['plan-writer']}, model: m }
  implementer: { runtime: ${r.implementer}, model: m }
  code-reviewer: { runtime: ${r['code-reviewer']}, model: m }
  security-reviewer: { runtime: ${r['security-reviewer']}, model: m }
  test-reviewer: { runtime: ${r['test-reviewer']}, model: m }
  spec-remediator: { runtime: ${r['spec-remediator']}, model: m }
  plan-remediator: { runtime: ${r['plan-remediator']}, model: m }
  code-remediator: { runtime: ${r['code-remediator']}, model: m }
`.trim();
};

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
        expect(config.issue_tracker.api_key_env).toBe('LINEAR_API_KEY');
        expect(config.issue_tracker.webhook_secret_env).toBe('LINEAR_WEBHOOK_SECRET');
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

    it('parses linear config with required fields', () => {
      const config = parseProductConfig(LINEAR_VALID);

      expect(config.issue_tracker.provider).toBe('linear');
      if (config.issue_tracker.provider === 'linear') {
        expect(config.issue_tracker.team_key).toBe('TEST');
        expect(config.issue_tracker.api_key_env).toBe('LINEAR_API_KEY');
        expect(config.issue_tracker.webhook_secret_env).toBe('LINEAR_WEBHOOK_SECRET');
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

  describe('specialist runtime consistency (H1 / ADR-021)', () => {
    it('accepts a uniform claude_code config', () => {
      const config = parseProductConfig(specialistsBlock({}));
      expect(config.specialists['spec-writer'].runtime).toBe('claude_code');
    });

    it('accepts a uniform codex config', () => {
      const config = parseProductConfig(
        specialistsBlock({
          'spec-writer': 'codex',
          'plan-writer': 'codex',
          implementer: 'codex',
          'code-reviewer': 'codex',
          'security-reviewer': 'codex',
          'test-reviewer': 'codex',
          'spec-remediator': 'codex',
          'plan-remediator': 'codex',
          'code-remediator': 'codex',
        }),
      );
      expect(config.specialists.implementer.runtime).toBe('codex');
    });

    it('rejects mixed specialist runtimes with a clear message', () => {
      const mixed = specialistsBlock({ implementer: 'codex' });
      expect(() => parseProductConfig(mixed)).toThrow(ProductConfigError);
      expect(() => parseProductConfig(mixed)).toThrow('All specialists must use the same runtime');
      // surfaces both runtimes (sorted) so the operator can see the conflict
      expect(() => parseProductConfig(mixed)).toThrow('claude_code, codex');
    });
  });
});

describe('parseProductConfigFromFile', () => {
  it('parses a valid YAML file from disk', async () => {
    const filePath = fileURLToPath(
      new URL('./__fixtures__/valid-github-projects.yaml', import.meta.url),
    );
    const config = await parseProductConfigFromFile(filePath);

    expect(config.product.slug).toBe('example-app');
    expect(config.issue_tracker.provider).toBe('github_projects');
  });

  it('throws ProductConfigError with preserved fs error code when file cannot be read', async () => {
    const missingPath = fileURLToPath(
      new URL('./__fixtures__/does-not-exist.yaml', import.meta.url),
    );
    const err = await parseProductConfigFromFile(missingPath).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProductConfigError);
    expect((err as ProductConfigError).message).toContain('Cannot read file:');
    // code is preserved so callers can check err.code === 'ENOENT' without inspecting cause
    expect((err as ProductConfigError).code).toBe('ENOENT');
  });
});
