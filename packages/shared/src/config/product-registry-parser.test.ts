import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProductRegistryYaml, loadProductRegistry } from './product-registry-parser.js';
import { ProductConfigError } from './product-parser.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_PRODUCT_YAML = `
helm_version: "0"
product:
  slug: test-product
  name: Test Product
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
  stages_enabled: [discovery, spec-ready, released]
specialists:
  spec_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  plan_writer: { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  code_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  security_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  test_reviewer: { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKnowledgeRepo(
  baseDir: string,
  slug: string,
  productYaml = VALID_PRODUCT_YAML,
): Promise<string> {
  const repoDir = join(baseDir, `${slug}-knowledge`);
  await mkdir(join(repoDir, '.helm'), { recursive: true });
  const yaml = productYaml.replace('test-product', slug).replace('Test Product', slug);
  await writeFile(join(repoDir, '.helm', 'product.yaml'), yaml, 'utf-8');
  return repoDir;
}

// ── parseProductRegistryYaml ─────────────────────────────────────────────────

describe('parseProductRegistryYaml', () => {
  it('parses a valid registry with one entry', () => {
    const yaml = `products:\n  - path: .`;
    const entries = parseProductRegistryYaml(yaml);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('.');
  });

  it('parses a registry with multiple entries', () => {
    const yaml = `products:\n  - path: .\n  - path: ../other-knowledge`;
    const entries = parseProductRegistryYaml(yaml);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.path).toBe('../other-knowledge');
  });

  it('throws ProductConfigError on invalid YAML syntax', () => {
    expect(() => parseProductRegistryYaml(': invalid: yaml: [')).toThrow(ProductConfigError);
  });

  it('throws ProductConfigError when products array is empty', () => {
    expect(() => parseProductRegistryYaml('products: []')).toThrow(ProductConfigError);
  });

  it('throws ProductConfigError when products key is missing', () => {
    expect(() => parseProductRegistryYaml('entries:\n  - path: .')).toThrow(ProductConfigError);
  });

  it('throws ProductConfigError when a path is empty string', () => {
    expect(() => parseProductRegistryYaml('products:\n  - path: ""')).toThrow(ProductConfigError);
  });
});

// ── loadProductRegistry ───────────────────────────────────────────────────────

describe('loadProductRegistry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `helm-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a single product from the registry', async () => {
    await makeKnowledgeRepo(tmpDir, 'alpha');
    const registryYaml = `products:\n  - path: alpha-knowledge`;
    const registryPath = join(tmpDir, 'products.yaml');
    await writeFile(registryPath, registryYaml, 'utf-8');

    const products = await loadProductRegistry(registryPath, tmpDir);
    expect(products).toHaveLength(1);
    expect(products[0]!.product.slug).toBe('alpha');
  });

  it('loads multiple products from the registry', async () => {
    await makeKnowledgeRepo(tmpDir, 'alpha');
    await makeKnowledgeRepo(tmpDir, 'beta');
    const registryYaml = `products:\n  - path: alpha-knowledge\n  - path: beta-knowledge`;
    const registryPath = join(tmpDir, 'products.yaml');
    await writeFile(registryPath, registryYaml, 'utf-8');

    const products = await loadProductRegistry(registryPath, tmpDir);
    expect(products).toHaveLength(2);
    const slugs = products.map((p) => p.product.slug).sort();
    expect(slugs).toEqual(['alpha', 'beta']);
  });

  it('resolves the "." path to the baseDir itself', async () => {
    // Treat tmpDir as the primary knowledge repo (path = ".")
    await mkdir(join(tmpDir, '.helm'), { recursive: true });
    await writeFile(join(tmpDir, '.helm', 'product.yaml'), VALID_PRODUCT_YAML, 'utf-8');
    const registryYaml = `products:\n  - path: .`;
    const registryPath = join(tmpDir, 'products.yaml');
    await writeFile(registryPath, registryYaml, 'utf-8');

    const products = await loadProductRegistry(registryPath, tmpDir);
    expect(products).toHaveLength(1);
    expect(products[0]!.product.slug).toBe('test-product');
  });

  it('throws ProductConfigError (ENOENT) when registry file is missing', async () => {
    await expect(
      loadProductRegistry(join(tmpDir, 'nonexistent.yaml'), tmpDir),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws ProductConfigError when a referenced product.yaml is missing', async () => {
    const registryYaml = `products:\n  - path: ghost-knowledge`;
    const registryPath = join(tmpDir, 'products.yaml');
    await writeFile(registryPath, registryYaml, 'utf-8');

    await expect(loadProductRegistry(registryPath, tmpDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('throws ProductConfigError when a referenced product.yaml is malformed', async () => {
    const repoDir = join(tmpDir, 'bad-knowledge');
    await mkdir(join(repoDir, '.helm'), { recursive: true });
    await writeFile(join(repoDir, '.helm', 'product.yaml'), 'not_valid: yaml: [', 'utf-8');
    const registryYaml = `products:\n  - path: bad-knowledge`;
    const registryPath = join(tmpDir, 'products.yaml');
    await writeFile(registryPath, registryYaml, 'utf-8');

    await expect(loadProductRegistry(registryPath, tmpDir)).rejects.toThrow(ProductConfigError);
  });
});
