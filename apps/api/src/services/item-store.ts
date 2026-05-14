import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import { INITIAL_STAGE, validateTransition } from '@helm/workflow';
import type { WorkflowStage } from '@helm/workflow';
import { ItemAlreadyExistsError, ItemNotFoundError } from './errors.js';
import type { ItemState, WorkflowEvent } from './types.js';

/**
 * File-based persistence for item workflow state.
 * Each item is stored as data/items/{externalId}.json using atomic writes.
 */
export class ItemStore {
  constructor(private readonly itemsDir: string) {}

  /**
   * Rejects externalIds that could escape itemsDir via path traversal or
   * produce dotfiles that list() would silently skip.
   * Allows typical tracker formats: MOM-142, HLM-7, issue_3, feature.v2
   * Blocks: slashes, backslashes, spaces, leading dots, and other specials.
   */
  private assertSafeExternalId(externalId: string): void {
    // (?!\.) — leading dot disallowed: list() drops dotfiles so .foo would
    // be persisted by create() but never returned by list().
    if (!/^(?!\.)[A-Za-z0-9._-]+$/.test(externalId)) {
      throw new Error(
        `Invalid externalId: "${externalId}". Must match [A-Za-z0-9._-]+ and must not start with "."`,
      );
    }
  }

  private itemPath(externalId: string): string {
    this.assertSafeExternalId(externalId);
    return join(this.itemsDir, `${externalId}.json`);
  }

  /** Returns the item's current state, or null if the item does not exist. */
  async get(externalId: string): Promise<ItemState | null> {
    return readJson<ItemState>(this.itemPath(externalId));
  }

  /**
   * Creates a new item at INITIAL_STAGE ('discovery') with a creation event.
   * Throws ItemAlreadyExistsError if an item with this externalId already exists.
   */
  async create(input: {
    externalId: string;
    productSlug: string;
    triggeredBy: string;
  }): Promise<ItemState> {
    const existing = await readJson<ItemState>(this.itemPath(input.externalId));
    if (existing !== null) {
      throw new ItemAlreadyExistsError(input.externalId);
    }

    const now = new Date().toISOString();
    const creationEvent: WorkflowEvent = {
      fromStage: null,
      toStage: INITIAL_STAGE,
      triggeredBy: input.triggeredBy,
      at: now,
    };

    const state: ItemState = {
      externalId: input.externalId,
      productSlug: input.productSlug,
      currentStage: INITIAL_STAGE,
      history: [creationEvent],
      createdAt: now,
      updatedAt: now,
    };

    await writeJsonAtomic(this.itemPath(input.externalId), state);
    return state;
  }

  /**
   * Advances an item to a new workflow stage.
   *
   * NOTE: This implementation has no concurrency control. If two callers
   * invoke transition() on the same externalId concurrently, the last write
   * wins and the intermediate transition is lost silently. This is acceptable
   * for v0 (single-process, single-user). Address with file locking or
   * optimistic versioning when parallel agents become real (target: Session 8+
   * with parallel reviewers).
   *
   * Throws ItemNotFoundError if the item does not exist.
   * Throws WorkflowTransitionError if the transition is not permitted.
   */
  async transition(input: {
    externalId: string;
    toStage: WorkflowStage;
    triggeredBy: string;
    note?: string;
  }): Promise<ItemState> {
    const current = await readJson<ItemState>(this.itemPath(input.externalId));
    if (current === null) {
      throw new ItemNotFoundError(input.externalId);
    }

    // Throws WorkflowTransitionError if the transition is not in VALID_TRANSITIONS.
    // The file is NOT written until after this check — invalid transitions are a no-op.
    validateTransition(current.currentStage, input.toStage);

    const now = new Date().toISOString();
    const event: WorkflowEvent = {
      fromStage: current.currentStage,
      toStage: input.toStage,
      triggeredBy: input.triggeredBy,
      at: now,
      note: input.note,
    };

    const updated: ItemState = {
      ...current,
      currentStage: input.toStage,
      history: [...current.history, event],
      updatedAt: now,
    };

    await writeJsonAtomic(this.itemPath(input.externalId), updated);
    return updated;
  }

  /**
   * Returns all items in the items directory.
   * Order is not guaranteed — callers should sort if needed.
   *
   * Filters out dotfiles and non-.json entries so .DS_Store, .gitkeep,
   * and temporary files do not cause parse errors.
   *
   * NOTE: In v0 this iterates the full directory on every call. Acceptable
   * for small workloads; add an index if query performance becomes a concern.
   */
  async list(): Promise<ItemState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.itemsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const itemFiles = entries.filter((f) => f.endsWith('.json') && !f.startsWith('.'));

    const results = await Promise.all(
      itemFiles.map((f) => readJson<ItemState>(join(this.itemsDir, f))),
    );

    return results.filter((s): s is ItemState => s !== null) as ItemState[];
  }
}
