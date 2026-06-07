import type { NativeStateType, WorkflowStage } from '@helm/workflow';
import type { IssueTracker } from '@helm/shared';
import type { ItemFilter, NormalizedEvent, NormalizedItem } from './types.js';

/**
 * Uniform contract for all issue tracker integrations.
 *
 * v0 implements two adapters: GitHubProjectsAdapter (Session 5) and
 * LinearAdapter (Session 11). Additional adapters (Jira, ClickUp, etc.)
 * are open contributions — each must fulfill this interface.
 *
 * Design principles:
 * - All methods are async; adapters may cache internally to reduce API calls.
 * - getItem returns null rather than throwing when an item is not found.
 * - parseWebhook is synchronous — normalising an in-memory payload needs no I/O.
 * - ensureSubStages is idempotent; safe to call on every server startup.
 */
export interface IssueTrackerAdapter {
  /**
   * Creates the tracker-specific structures required for Helm sub-stages:
   * - GitHub Projects: ensures the "Helm Stage" single-select custom field exists.
   * - Linear: ensures all 9 `helm:*` labels exist in the configured team.
   * Safe to call repeatedly; must not duplicate existing structures.
   */
  ensureSubStages(config: IssueTracker): Promise<void>;

  /** Returns the item, or null if it does not exist in the tracker. */
  getItem(externalId: string): Promise<NormalizedItem | null>;

  /** Returns all items matching the optional filter. */
  listItems(filter?: ItemFilter): Promise<NormalizedItem[]>;

  /** Updates the Helm sub-stage field on the tracker item. */
  setSubStage(externalId: string, subStage: WorkflowStage): Promise<void>;

  /** Updates the open/closed status of the tracker item. */
  setStatus(externalId: string, status: 'open' | 'closed'): Promise<void>;

  /**
   * Optional capability (ADR-034): set the item's NATIVE workflow state by type
   * (`started` → "In Development", `completed` → "Completed"), mirroring the
   * Helm stage into the tracker's native Status column in addition to the
   * `helm:*` sub-stage label.
   *
   * Optional because not every tracker can resolve a state by type: the Linear
   * adapter implements it; GitHub Projects' native Status (a project
   * single-select) is a deferred follow-up and leaves this undefined. Call sites
   * must feature-detect (`adapter.setWorkflowStateByType?.(…)`) and gate on a
   * Linear product, so non-Linear adapters skip it cleanly.
   */
  setWorkflowStateByType?(externalId: string, type: NativeStateType): Promise<void>;

  /** Posts a comment on the tracker item. */
  comment(externalId: string, body: string): Promise<void>;

  /**
   * Normalises a raw webhook payload into a Helm-internal NormalizedEvent.
   * Must never throw — unrecognised payloads should return { type: 'unknown' }.
   * Real adapters MUST validate rawEvent with Zod before mapping to NormalizedEvent.
   */
  parseWebhook(rawEvent: unknown): NormalizedEvent;

  /** Registers Helm's webhook endpoint with the tracker provider. */
  registerWebhook(callbackUrl: string): Promise<void>;
}
