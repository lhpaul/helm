import type { WorkflowStage } from '@helm/workflow';

/**
 * Helm's internal representation of a tracker item.
 * Produced by IssueTrackerAdapter.getItem() / listItems() — tracker-agnostic.
 */
export type NormalizedItem = {
  /** Tracker-specific identifier: 'MOM-142', 'issue_3', 'HLM-7', etc. */
  externalId: string;
  title: string;
  /** Current Helm workflow sub-stage, or null if not yet assigned. */
  subStage: WorkflowStage | null;
  status: 'open' | 'closed';
  /** Deep link to the item in the tracker UI. */
  url: string;
};

/**
 * Optional filters for IssueTrackerAdapter.listItems().
 */
export type ItemFilter = {
  status?: 'open' | 'closed';
  subStage?: WorkflowStage;
};

/**
 * Normalized event emitted by IssueTrackerAdapter.parseWebhook().
 *
 * item_updated carries the NEW values of changed fields (not diffs).
 * A single tracker event can update both subStage and status simultaneously
 * (e.g., transitioning to 'released' also closes the issue).
 *
 * The 'unknown' variant is a safe catch-all for unrecognized webhook payloads
 * — real adapters should never throw on unknown events; the caller decides
 * whether to ignore or log them.
 */
export type NormalizedEvent =
  | { type: 'item_created'; externalId: string; timestamp: string }
  | {
      type: 'item_updated';
      externalId: string;
      /** New subStage value if it changed; omitted if unchanged. */
      subStage?: WorkflowStage | null;
      /** New status value if it changed; omitted if unchanged. */
      status?: 'open' | 'closed';
      timestamp: string;
    }
  | { type: 'comment_added'; externalId: string; body: string; timestamp: string }
  | { type: 'unknown'; raw: unknown };
