import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncProductItems } from './sync.js';
import type { SyncOptions } from './sync.js';
import type { NormalizedItem } from '@helm/adapters';
import type { Product } from '@helm/shared';
import { INITIAL_STAGE } from '@helm/workflow';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PRODUCT: Product = {
  helm_version: '0',
  product: { slug: 'helm-playground', name: 'Helm Playground' },
  issue_tracker: {
    provider: 'github_projects',
    org: 'lhpaul',
    project_number: 5,
    custom_field_name: 'Helm Stage',
  },
  code_repos: [
    { url: 'https://github.com/lhpaul/helm-playground', default_branch: 'main', role: 'app' },
  ],
  knowledge_repo: {
    url: 'https://github.com/lhpaul/helm-playground-knowledge',
    default_branch: 'main',
  },
  workflow: {
    stages_enabled: ['discovery', 'spec-ready', 'released'],
    designer_gate: 'skip',
    qa_gate: 'skip',
  },
  specialists: {
    spec_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    plan_writer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
    code_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    security_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    test_reviewer: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    remediation: { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
  },
};

function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: 'issue_1',
    title: 'Hello world endpoint',
    subStage: 'discovery',
    status: 'open',
    url: 'https://github.com/lhpaul/helm-playground/issues/1',
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOptions(
  items: NormalizedItem[],
  capturedWrites: Array<{ path: string; data: unknown }> = [],
): SyncOptions {
  return {
    _listItems: () => Promise.resolve(items),
    _writeJson: async (filePath, data) => {
      capturedWrites.push({ path: filePath, data });
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncProductItems', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `helm-sync-test-${randomUUID()}`);
    await mkdir(join(tmpDir, 'items'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('returns synced count and writes one ItemState file', async () => {
      const writes: Array<{ path: string; data: unknown }> = [];
      const result = await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions([makeItem()], writes),
      );

      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(writes).toHaveLength(1);
    });

    it('writes the correct ItemState shape', async () => {
      const writes: Array<{ path: string; data: unknown }> = [];
      await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions([makeItem({ externalId: 'issue_42', subStage: 'spec-ready' })], writes),
      );

      const state = writes[0]!.data as Record<string, unknown>;
      expect(state.externalId).toBe('issue_42');
      expect(state.productSlug).toBe('helm-playground');
      expect(state.currentStage).toBe('spec-ready');
      expect(state.history).toHaveLength(1);
      expect((state.history as Array<Record<string, unknown>>)[0]!.triggeredBy).toBe(
        'sync:github-projects',
      );
      expect((state.history as Array<Record<string, unknown>>)[0]!.fromStage).toBeNull();
    });

    it('writes the file path under items/ dir', async () => {
      const writes: Array<{ path: string; data: unknown }> = [];
      await syncProductItems(BASE_PRODUCT, 'token', tmpDir, makeOptions([makeItem()], writes));

      expect(writes[0]!.path).toContain('items');
      expect(writes[0]!.path).toContain('issue_1.json');
    });

    it('syncs multiple items', async () => {
      const items = [
        makeItem({ externalId: 'issue_1' }),
        makeItem({ externalId: 'issue_2', subStage: 'plan-ready' }),
        makeItem({ externalId: 'issue_3', subStage: null }),
      ];
      const writes: Array<{ path: string; data: unknown }> = [];
      const result = await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions(items, writes),
      );

      expect(result.synced).toBe(3);
      expect(writes).toHaveLength(3);
    });
  });

  describe('stage mapping', () => {
    it('uses item.subStage when set', async () => {
      const writes: Array<{ path: string; data: unknown }> = [];
      await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions([makeItem({ subStage: 'code-review' })], writes),
      );

      expect((writes[0]!.data as Record<string, unknown>).currentStage).toBe('code-review');
    });

    it('falls back to INITIAL_STAGE when subStage is null', async () => {
      const writes: Array<{ path: string; data: unknown }> = [];
      await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions([makeItem({ subStage: null })], writes),
      );

      expect((writes[0]!.data as Record<string, unknown>).currentStage).toBe(INITIAL_STAGE);
    });
  });

  describe('idempotency', () => {
    it('writes the same data on two successive runs', async () => {
      const writes1: Array<{ path: string; data: unknown }> = [];
      const writes2: Array<{ path: string; data: unknown }> = [];
      const item = makeItem({ externalId: 'issue_7', subStage: 'discovery' });
      const opts1 = makeOptions([item], writes1);
      const opts2 = makeOptions([item], writes2);

      await syncProductItems(BASE_PRODUCT, 'token', tmpDir, opts1);
      await syncProductItems(BASE_PRODUCT, 'token', tmpDir, opts2);

      expect(writes1).toHaveLength(1);
      expect(writes2).toHaveLength(1);
      const s1 = writes1[0]!.data as Record<string, unknown>;
      const s2 = writes2[0]!.data as Record<string, unknown>;
      expect(s1.externalId).toBe(s2.externalId);
      expect(s1.currentStage).toBe(s2.currentStage);
    });
  });

  describe('error cases', () => {
    it('throws when provider is not github_projects', async () => {
      const linearProduct: Product = {
        ...BASE_PRODUCT,
        issue_tracker: {
          provider: 'linear',
          workspace: 'helm-dev',
          team_key: 'HLM',
          label_prefix: 'helm:',
        },
      };

      await expect(
        syncProductItems(linearProduct, 'token', tmpDir, makeOptions([])),
      ).rejects.toThrow("sync only supports provider 'github_projects'");
    });

    it('skips items with invalid externalIds and increments skipped count', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const writes: Array<{ path: string; data: unknown }> = [];
      const items = [
        makeItem({ externalId: 'issue_1' }), // valid
        makeItem({ externalId: '../traversal' }), // invalid
        makeItem({ externalId: '.hidden' }), // invalid (leading dot)
        makeItem({ externalId: 'issue_2' }), // valid
      ];

      const result = await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions(items, writes),
      );

      expect(result.synced).toBe(2);
      expect(result.skipped).toBe(2);
      expect(writes).toHaveLength(2);
      consoleSpy.mockRestore();
    });

    it('returns synced=0 when adapter returns empty list', async () => {
      const result = await syncProductItems(BASE_PRODUCT, 'token', tmpDir, makeOptions([]));
      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });
});
