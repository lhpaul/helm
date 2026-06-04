import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { ClaudeCodeRuntime, CodexRuntime, MockAgentRuntime } from '@helm/orchestrator';
import { createRuntimeForProduct, createMockRuntimeForSpec } from './runtime-factory.js';
import type { Product } from '@helm/shared';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeProduct = (runtime: 'claude_code' | 'codex' = 'claude_code'): Product => ({
  helm_version: '0',
  product: { slug: 'test-product', name: 'Test Product' },
  issue_tracker: {
    provider: 'github_projects',
    org: 'test-org',
    project_number: 1,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [{ url: 'https://github.com/test-org/test', default_branch: 'main', role: 'app' }],
  knowledge_repo: { url: 'https://github.com/test-org/knowledge', default_branch: 'main' },
  workflow: {
    stages_enabled: ['discovery', 'spec-draft', 'released'],
    designer_gate: 'skip',
    qa_gate: 'skip',
    readiness_gate: 'skip',
    final_stage: 'released',
  },
  // Uniform runtime across all specialists — mirrors the H1 constraint enforced
  // by ProductSchema (and the factory's defense-in-depth check). Tests that need
  // a mixed config mutate a single specialist after construction.
  specialists: {
    'spec-writer': { runtime, model: 'claude-sonnet-4-6' },
    'plan-writer': { runtime, model: 'claude-sonnet-4-6' },
    implementer: { runtime, model: 'claude-opus-4-7' },
    'code-reviewer': { runtime, model: 'claude-sonnet-4-6' },
    'security-reviewer': { runtime, model: 'claude-sonnet-4-6' },
    'test-reviewer': { runtime, model: 'claude-sonnet-4-6' },
    'spec-remediator': { runtime, model: 'claude-sonnet-4-6' },
    'plan-remediator': { runtime, model: 'claude-sonnet-4-6' },
    'code-remediator': { runtime, model: 'claude-sonnet-4-6' },
  },
});

const makeSpawnParams = (workdir: string, externalId = 'issue_1') => ({
  specialistId: 'spec-writer' as const,
  prompt: 'Write a spec.',
  workdir,
  productSlug: 'test-product',
  externalId,
  model: 'claude-sonnet-4-6' as const,
});

// ── createRuntimeForProduct ───────────────────────────────────────────────────

describe('createRuntimeForProduct', () => {
  it("returns a ClaudeCodeRuntime for runtime: 'claude_code'", () => {
    const product = makeProduct('claude_code');
    const runtime = createRuntimeForProduct(product, 'issue_1', '/tmp/workdir');
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
  });

  it("returns a CodexRuntime for runtime: 'codex'", () => {
    const product = makeProduct('codex');
    const runtime = createRuntimeForProduct(product, 'issue_1', '/tmp/workdir');
    expect(runtime).toBeInstanceOf(CodexRuntime);
  });

  it('throws a descriptive error for an unknown runtime value', () => {
    // Cast to bypass TypeScript's type check — simulates a bad config file
    const product = makeProduct('unknown_runtime' as 'claude_code');
    expect(() => createRuntimeForProduct(product, 'issue_1', '/tmp/workdir')).toThrow(
      /Unknown specialist runtime.*'unknown_runtime'/,
    );
  });

  it('throws on mixed specialist runtimes (H1 defense-in-depth, bypassing schema)', () => {
    // Build a Product directly (not via ProductSchema), as a programmatic caller
    // or test might. The factory must still reject mixed runtimes rather than
    // silently using spec-writer's runtime for every specialist.
    const product = makeProduct('claude_code');
    product.specialists.implementer.runtime = 'codex';
    expect(() => createRuntimeForProduct(product, 'issue_1', '/tmp/workdir')).toThrow(
      /ADR-021 H1 violation.*claude_code, codex/,
    );
  });
});

// ── createMockRuntimeForSpec ──────────────────────────────────────────────────

describe('createMockRuntimeForSpec', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a MockAgentRuntime instance', () => {
    const runtime = createMockRuntimeForSpec('issue_1');
    expect(runtime).toBeInstanceOf(MockAgentRuntime);
  });

  it('throws for an externalId that would enable path traversal', () => {
    expect(() => createMockRuntimeForSpec('../escape')).toThrow(/Invalid externalId/);
    expect(() => createMockRuntimeForSpec('.')).toThrow(/Invalid externalId/);
    expect(() => createMockRuntimeForSpec('bad/slash')).toThrow(/Invalid externalId/);
  });

  it('spawn() writes a spec file at specs/<externalId>.md inside workdir', async () => {
    tempDir = join(tmpdir(), `runtime-factory-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });

    const externalId = 'issue_42';
    const runtime = createMockRuntimeForSpec(externalId);
    const session = await runtime.spawn(makeSpawnParams(tempDir, externalId));
    await session.wait();

    const specPath = join(tempDir, 'specs', `${externalId}.md`);
    await expect(access(specPath)).resolves.toBeUndefined();

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain(externalId);
  });

  it('spawn() is idempotent — re-dispatch does not throw (EEXIST ignored)', async () => {
    tempDir = join(tmpdir(), `runtime-factory-test-${randomUUID()}`);
    await mkdir(join(tempDir, 'specs'), { recursive: true });

    const externalId = 'issue_42';
    // Pre-create the file to simulate a re-dispatch scenario
    await writeFile(join(tempDir, 'specs', `${externalId}.md`), 'existing content');

    const runtime = createMockRuntimeForSpec(externalId);
    const session = await runtime.spawn(makeSpawnParams(tempDir, externalId));

    // Second run must not throw even though the file already exists
    await expect(session.wait()).resolves.toMatchObject({ status: 'done' });
  });
});
