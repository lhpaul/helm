import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '@helm/storage';
import { INITIAL_STAGE, validateTransition } from '@helm/workflow';
import type { WorkflowStage } from '@helm/workflow';
import { ItemAlreadyExistsError, ItemNotFoundError, StageMismatchError } from './errors.js';
import { EXTERNAL_ID_REGEX } from './types.js';
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
    // EXTERNAL_ID_REGEX is the single source of truth (defined in types.ts).
    // This check is defense-in-depth — route handlers validate first.
    if (!EXTERNAL_ID_REGEX.test(externalId)) {
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
   *
   * Uses writeFile with flag 'wx' (exclusive create) for atomic check-and-create:
   * the OS rejects the write with EEXIST if the file already exists, eliminating
   * the read-then-write race of a readJson+writeJsonAtomic sequence.
   */
  async create(input: {
    externalId: string;
    productSlug: string;
    triggeredBy: string;
  }): Promise<ItemState> {
    const filePath = this.itemPath(input.externalId);
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

    try {
      await writeFile(filePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ItemAlreadyExistsError(input.externalId);
      }
      throw err;
    }

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

    return this.applyTransition(current, input);
  }

  /**
   * Applies a workflow transition WITHOUT the validateTransition guard.
   *
   * This deliberately bypasses the state machine's VALID_TRANSITIONS map and is
   * reserved for explicit operator escape valves — specifically rolling a failed
   * implementer dispatch back from 'in-development' to 'plan-ready' (see ADR-029).
   * It is NOT part of the happy-path workflow: normal/forward edges MUST use
   * transition(), which keeps the state-machine guard intact. Callers of this
   * method are security-sensitive and should be enforced by their own allow-list
   * (the rollback route pins the pair via strict Zod literals).
   *
   * Asserts the item's current stage matches `fromStage` to guard against races
   * (the item moved since the operator read its state). The file is NOT written
   * unless the guard passes.
   *
   * Throws ItemNotFoundError if the item does not exist.
   * Throws StageMismatchError if the current stage does not match `fromStage`.
   */
  async forceTransition(input: {
    externalId: string;
    fromStage: WorkflowStage;
    toStage: WorkflowStage;
    triggeredBy: string;
    note?: string;
  }): Promise<ItemState> {
    const current = await readJson<ItemState>(this.itemPath(input.externalId));
    if (current === null) {
      throw new ItemNotFoundError(input.externalId);
    }

    if (current.currentStage !== input.fromStage) {
      throw new StageMismatchError(input.externalId, input.fromStage, current.currentStage);
    }

    return this.applyTransition(current, input);
  }

  /**
   * Shared internals for transition() and forceTransition(): appends the
   * history event and persists atomically. Does NOT validate the edge — the
   * public methods are responsible for whatever guard (or bypass) applies.
   */
  private async applyTransition(
    current: ItemState,
    input: { toStage: WorkflowStage; triggeredBy: string; note?: string },
  ): Promise<ItemState> {
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

    await writeJsonAtomic(this.itemPath(current.externalId), updated);
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
