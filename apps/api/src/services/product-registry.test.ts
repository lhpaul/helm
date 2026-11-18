/**
 * Focused regression tests for getProductRegistry() fallback logic.
 * Uses a real tmpdir so the ENOENT originates from the actual filesystem,
 * matching the production code path exactly.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  'spec-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'plan-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  'code-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'security-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'test-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  spec-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
  code-remediator: { runtime: claude_code, model: claude-sonnet-4-6 }
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

  it('returns all products when products.yaml is present with path "."', async () => {
    // path: "." is relative to HELM_KNOWLEDGE_REPO_PATH itself (the knowledge repo root)
    const productsYaml = `products:\n  - path: .`;
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

describe('getProductRegistry() path resolution semantics', () => {
  let tmpDir: string;
  const origEnv = process.env.HELM_KNOWLEDGE_REPO_PATH;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `helm-registry-path-test-${randomUUID()}`);
    // Primary knowledge repo: tmpDir itself
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

  it('path "." resolves to the knowledge repo itself (not its parent)', async () => {
    const productsYaml = `products:\n  - path: .`;
    await writeFile(join(tmpDir, '.helm', 'products.yaml'), productsYaml, 'utf-8');

    const products = await getProductRegistry();
    expect(products).toHaveLength(1);
    expect(products[0]!.product.slug).toBe('test-helm');
  });

  it('path "../sibling" resolves to a sibling directory of the knowledge repo', async () => {
    // Create a sibling repo next to tmpDir
    const siblingDir = join(tmpdir(), `helm-sibling-${randomUUID()}`);
    try {
      await mkdir(join(siblingDir, '.helm'), { recursive: true });
      const siblingYaml = PRODUCT_YAML.replace('test-helm', 'sibling-product').replace(
        'Test Helm',
        'Sibling Product',
      );
      await writeFile(join(siblingDir, '.helm', 'product.yaml'), siblingYaml, 'utf-8');

      const siblingName = `../${siblingDir.split('/').at(-1)!}`;
      const productsYaml = `products:\n  - path: .\n  - path: ${siblingName}`;
      await writeFile(join(tmpDir, '.helm', 'products.yaml'), productsYaml, 'utf-8');

      const products = await getProductRegistry();
      expect(products).toHaveLength(2);
      const slugs = products.map((p) => p.product.slug).sort();
      expect(slugs).toEqual(['sibling-product', 'test-helm']);
    } finally {
      await rm(siblingDir, { recursive: true, force: true });
    }
  });
});
