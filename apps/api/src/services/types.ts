import type { WorkflowStage } from '@helm/workflow';

/**
 * A single recorded transition in an item's workflow history.
 * fromStage is null only for the initial creation event.
 */
export type WorkflowEvent = {
  fromStage: WorkflowStage | null;
  toStage: WorkflowStage;
  /** Who triggered the transition: 'agent:spec-writer', 'human:lhpaul', 'webhook:github-projects', etc. */
  triggeredBy: string;
  /** ISO 8601 timestamp */
  at: string;
  /** Optional human-readable context for the transition */
  note?: string;
};

/**
 * The persisted state of a tracked item in Helm's workflow.
 * Written to data/items/{externalId}.json by ItemStore.
 */
export type ItemState = {
  /** Tracker-agnostic identifier: 'issue_3', 'MOM-142', 'HLM-7', etc. */
  externalId: string;
  /** Slug of the product this item belongs to */
  productSlug: string;
  currentStage: WorkflowStage;
  /** Always contains at least one event (the creation event with fromStage=null) */
  history: WorkflowEvent[];
  /** ISO 8601 — set on creation, never changes */
  createdAt: string;
  /** ISO 8601 — updated on every transition */
  updatedAt: string;
};
