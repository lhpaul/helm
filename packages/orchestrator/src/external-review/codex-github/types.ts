import type { ExternalReviewContext } from '../types.js';

export type CodexGitHubSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type CodexGitHubReviewConfig = {
  blockingSeverities: CodexGitHubSeverity[];
  deferWhenPending: boolean;
};

/**
 * The submitted PR review Codex posts when its analysis finishes. This — not a
 * commit status — is Codex's completion signal, so its presence for the target
 * revision is what separates "reviewed" from "still pending".
 */
export type CodexGitHubReviewSummaryPayload = {
  id?: number | string;
  node_id?: string;
  /** GitHub review state: COMMENTED | CHANGES_REQUESTED | APPROVED | DISMISSED. */
  state?: string;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
  user?: { login?: string | null } | null;
};

/** Optional in-flight check run, used only to defer while Codex is still running. */
export type CodexGitHubCheckRunPayload = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string | null;
};

export type CodexGitHubReviewCommentPayload = {
  id?: number | string;
  node_id?: string;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: { login?: string | null } | null;
};

export type CodexGitHubReviewThreadPayload = {
  id?: string | number;
  isResolved?: boolean;
  is_resolved?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: CodexGitHubReviewCommentPayload[];
};

export type CodexGitHubReviewPayload = {
  /** The payload could not be built at all (no PR, unresolvable revision). */
  unavailable?: boolean;
  error?: string;
  /**
   * Codex has not submitted a review for the target revision yet. Distinct from
   * `unavailable`: the fetch succeeded, the verdict simply has not landed.
   */
  reviewPending?: boolean;
  review?: CodexGitHubReviewSummaryPayload;
  checkRun?: CodexGitHubCheckRunPayload;
  reviewComments?: CodexGitHubReviewCommentPayload[];
  reviewThreads?: CodexGitHubReviewThreadPayload[];
};

export type LoadCodexGitHubReview = (
  ctx: ExternalReviewContext,
) => Promise<CodexGitHubReviewPayload | null> | CodexGitHubReviewPayload | null;
