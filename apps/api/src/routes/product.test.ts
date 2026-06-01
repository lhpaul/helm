import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';

// Minimal valid config — reuses the same shape as packages/shared test fixtures
const VALID_PRODUCT_YAML = `
helm_version: "0"
product:
  slug: example-app
  name: Example App
issue_tracker:
  provider: github_projects
  org: example-org
  project_number: 42
code_repos:
  - url: https://github.com/example-org/example-app
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/example-org/example-app-knowledge
  default_branch: main
workflow:
  stages_enabled: [in-development, released]
specialists:
  'spec-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'plan-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  'code-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'security-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'test-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

// Valid YAML but with a slug that fails the regex — triggers Zod validation error
const INVALID_SCHEMA_YAML = `
helm_version: "0"
product:
  slug: "INVALID SLUG WITH SPACES"
  name: Test
issue_tracker:
  provider: github_projects
  org: test-org
  project_number: 1
code_repos:
  - url: https://github.com/test/test
    default_branch: main
    role: app
knowledge_repo:
  url: https://github.com/test/test-knowledge
  default_branch: main
workflow:
  stages_enabled: [in-development, released]
specialists:
  'spec-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'plan-writer': { runtime: claude_code, model: claude-sonnet-4-6 }
  implementer: { runtime: claude_code, model: claude-opus-4-7 }
  'code-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'security-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  'test-reviewer': { runtime: claude_code, model: claude-sonnet-4-6 }
  remediation: { runtime: claude_code, model: claude-sonnet-4-6 }
`.trim();

let testDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  testDir = join(tmpdir(), `helm-api-product-${randomUUID()}`);
  await mkdir(join(testDir, '.helm'), { recursive: true });
  // snapshot current env so each test starts from a clean slate
  originalEnv = process.env.HELM_KNOWLEDGE_REPO_PATH;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env.HELM_KNOWLEDGE_REPO_PATH;
  } else {
    process.env.HELM_KNOWLEDGE_REPO_PATH = originalEnv;
  }
});

describe('GET /api/product', () => {
  it('returns 200 with parsed Product when config is valid', async () => {
    await writeFile(join(testDir, '.helm', 'product.yaml'), VALID_PRODUCT_YAML, 'utf-8');
    process.env.HELM_KNOWLEDGE_REPO_PATH = testDir;

    const res = await app.request('/api/product');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: { slug: string };
      issue_tracker: { provider: string };
    };
    expect(body.product.slug).toBe('example-app');
    expect(body.issue_tracker.provider).toBe('github_projects');
  });

  it('returns 404 when product.yaml does not exist at expected location', async () => {
    // dir exists but no .helm/product.yaml
    process.env.HELM_KNOWLEDGE_REPO_PATH = testDir;

    const res = await app.request('/api/product');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
    expect(body.error).toContain('.helm/product.yaml');
  });

  it('returns 500 with field path when schema is invalid', async () => {
    await writeFile(join(testDir, '.helm', 'product.yaml'), INVALID_SCHEMA_YAML, 'utf-8');
    process.env.HELM_KNOWLEDGE_REPO_PATH = testDir;

    const res = await app.request('/api/product');

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('product.slug');
  });

  it('returns 500 when HELM_KNOWLEDGE_REPO_PATH is not set', async () => {
    delete process.env.HELM_KNOWLEDGE_REPO_PATH;

    const res = await app.request('/api/product');

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('HELM_KNOWLEDGE_REPO_PATH');
  });
});
