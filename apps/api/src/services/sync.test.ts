import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemState } from './types.js';
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
    readiness_gate: 'skip',
  },
  specialists: {
    'spec-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'plan-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
    'code-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'security-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'test-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'spec-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'plan-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
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
  existingState: Record<string, ItemState> = {},
): SyncOptions {
  return {
    _listItems: () => Promise.resolve(items),
    _writeJson: async (filePath, data) => {
      capturedWrites.push({ path: filePath, data });
    },
    _readJson: async <T>(filePath: string): Promise<T | null> => {
      const key = basename(filePath).replace('.json', '');
      return (existingState[key] ?? null) as T | null;
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
    vi.restoreAllMocks();
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
    it('skips the write on second run when stage is unchanged (no file drift)', async () => {
      const item = makeItem({ externalId: 'issue_7', subStage: 'discovery' });
      const writes1: Array<{ path: string; data: unknown }> = [];

      // First run: no existing state → creates fresh
      await syncProductItems(BASE_PRODUCT, 'token', tmpDir, makeOptions([item], writes1));
      expect(writes1).toHaveLength(1);
      const firstState = writes1[0]!.data as ItemState;

      // Second run: existing state has same stage → skip write (continue)
      const writes2: Array<{ path: string; data: unknown }> = [];
      const existing: Record<string, ItemState> = { issue_7: firstState };
      await syncProductItems(BASE_PRODUCT, 'token', tmpDir, makeOptions([item], writes2, existing));
      expect(writes2).toHaveLength(0); // no write — content unchanged
    });

    it('preserves createdAt and appends to history when stage changes on re-sync', async () => {
      const item = makeItem({ externalId: 'issue_8', subStage: 'discovery' });
      const writes1: Array<{ path: string; data: unknown }> = [];
      await syncProductItems(BASE_PRODUCT, 'token', tmpDir, makeOptions([item], writes1));
      const firstState = writes1[0]!.data as ItemState;

      // Re-sync with a different stage
      const updatedItem = makeItem({ externalId: 'issue_8', subStage: 'spec-ready' });
      const writes2: Array<{ path: string; data: unknown }> = [];
      const existing: Record<string, ItemState> = { issue_8: firstState };
      await syncProductItems(
        BASE_PRODUCT,
        'token',
        tmpDir,
        makeOptions([updatedItem], writes2, existing),
      );

      expect(writes2).toHaveLength(1);
      const secondState = writes2[0]!.data as ItemState;
      expect(secondState.createdAt).toBe(firstState.createdAt); // preserved
      expect(secondState.currentStage).toBe('spec-ready');
      expect(secondState.history).toHaveLength(2); // creation + transition
    });
  });

  describe('error cases', () => {
    it('throws when provider is not github_projects', async () => {
      const linearProduct: Product = {
        ...BASE_PRODUCT,
        issue_tracker: {
          provider: 'linear',
          api_key_env: 'LINEAR_API_KEY',
          team_key: 'HLM',
          webhook_secret_env: 'LINEAR_WEBHOOK_SECRET',
        },
      };

      await expect(
        syncProductItems(linearProduct, 'token', tmpDir, makeOptions([])),
      ).rejects.toThrow("sync only supports provider 'github_projects'");
    });

    it('skips items with invalid externalIds and increments skipped count', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    });

    it('returns synced=0 when adapter returns empty list', async () => {
      const result = await syncProductItems(BASE_PRODUCT, 'token', tmpDir, makeOptions([]));
      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });
});
