import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProductConfigError, parseProductConfig } from './product-parser.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');

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
