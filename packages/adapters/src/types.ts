import type { WorkflowStage } from '@helm/workflow';

/**
 * Helm's internal representation of a tracker item.
 * Produced by IssueTrackerAdapter.getItem() / listItems() — tracker-agnostic.
 */
export type NormalizedItem = {
  /** Tracker-specific identifier: 'MOM-142', 'issue_3', 'HLM-7', etc. */
  externalId: string;
  title: string;
  /**
   * Long-form description of the item (the issue body in GitHub).
   * Optional — trackers or items that have no description leave this undefined.
   */
  body?: string;
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
  /**
   * A pull request was merged. headRef is the source branch name
   * (e.g. `helm/spec/HLM-42`). The webhook route is responsible for
   * interpreting the branch name convention — the adapter emits the raw ref
   * without applying any Helm-specific semantics.
   */
  | {
      type: 'pull_request_merged';
      headRef: string;
      owner: string | null;
      repo: string | null;
      prNumber: number | null;
      pullRequestId: number | null;
      timestamp: string;
    }
  /**
   * A pull request head became available or changed (actions: opened/reopened/synchronize).
   * headRef is the PR source branch (e.g. `helm/impl/LEA-192`).
   */
  | {
      type: 'pull_request_synchronized';
      headRef: string;
      owner: string | null;
      repo: string | null;
      /** Head repository owner when present — used to reject fork-originated early-loop PRs. */
      headOwner: string | null;
      /** Head repository name when present — used to reject fork-originated early-loop PRs. */
      headRepo: string | null;
      prNumber?: number;
      headSha?: string;
      /** GitHub `sender.login` when present — used to ignore orchestrator bot pushes. */
      senderLogin: string | null;
      timestamp: string;
    }
  | {
      type: 'pull_request_comment_created';
      owner: string;
      repo: string;
      prNumber: number;
      body: string;
      authorLogin: string | null;
      timestamp: string;
    }
  | {
      type: 'external_review_ready';
      provider: string;
      owner: string | null;
      repo: string | null;
      /** Present when the check_run payload includes pull_requests; may be absent. */
      prNumber?: number;
      targetRevision: string;
      headRef?: string;
      timestamp: string;
    }
  /**
   * A GitHub release was published (release event, action: 'published').
   * Repo-level and tracker-agnostic — like pull_request_merged, the webhook
   * route interprets it (bulk-promoting the instance product's `merged` items
   * to `released`). `tag` is the release tag name, carried for logging/audit;
   * the route does not key any per-item mapping off it (ADR-032).
   */
  | { type: 'release_published'; tag: string; timestamp: string }
  | { type: 'unknown'; raw: unknown };
