/**
 * Focused regression tests for getProductRegistry() fallback logic.
 * Uses a real tmpdir so the ENOENT originates from the actual filesystem,
 * matching the production code path exactly.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetForTests, getProductRegistry } from './index.js';

// Minimal valid product.yaml
const PRODUCT_YAML = `
helm_version: "0"
product:
  slug: test-helm
  name: Test Helm
issue_tracker:
  provider: github_projects
  org: test-org
  project_number: 1
code_repos:
  - url: https://github.com/test-org/test-repo
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

describe('getProductRegistry() ENOENT fallback', () => {
  let tmpDir: string;
  const origEnv = process.env.HELM_KNOWLEDGE_REPO_PATH;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `helm-registry-test-${randomUUID()}`);
    await mkdir(join(tmpDir, '.helm'), { recursive: true });
    await writeFile(join(tmpDir, '.helm', 'product.yaml'), PRODUCT_YAML, 'utf-8');
    process.env.HELM_KNOWLEDGE_REPO_PATH = tmpDir;
    _resetForTests();
  });

  afterEach(async () => {
    _resetForTests();
    if (origEnv === undefined) {
      delete process.env.HELM_KNOWLEDGE_REPO_PATH;
    } else {
      process.env.HELM_KNOWLEDGE_REPO_PATH = origEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to [getProductConfig()] when products.yaml is absent', async () => {
    // No products.yaml in tmpDir/.helm/ — only product.yaml exists
    const products = await getProductRegistry();
    expect(products).toHaveLength(1);
    expect(products[0]!.product.slug).toBe('test-helm');
  });

  it('returns all products when products.yaml is present', async () => {
    // baseDir = dirname(tmpDir), so the relative path to tmpDir itself is basename(tmpDir)
    const productsYaml = `products:\n  - path: ${basename(tmpDir)}`;
    await writeFile(join(tmpDir, '.helm', 'products.yaml'), productsYaml, 'utf-8');

    const products = await getProductRegistry();
    expect(products).toHaveLength(1);
    expect(products[0]!.product.slug).toBe('test-helm');
  });

  it('propagates error when a referenced product.yaml is missing (not swallowed as fallback)', async () => {
    const productsYaml = `products:\n  - path: ./nonexistent-repo`;
    await writeFile(join(tmpDir, '.helm', 'products.yaml'), productsYaml, 'utf-8');

    await expect(getProductRegistry()).rejects.toThrow();
  });
});
