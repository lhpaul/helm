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

/**
 * A root PR comment authored by a trusted Codex identity.
 *
 * Root comments are the second evidence channel: Codex ends a clean run with a
 * SHA-pinned summary comment far more reliably than with a submitted review,
 * and reports quota exhaustion and a missing cloud environment here too.
 */
export type CodexGitHubRootCommentPayload = {
  id?: number | string;
  node_id?: string;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null } | null;
};

/** Why Codex produced no usable verdict. Surfaces on the skipped result. */
export type CodexGitHubUnavailableReason =
  | 'usage_limit'
  | 'environment_missing'
  | 'root_comments_unavailable'
  | 'unrecognized_terminal_response'
  | 'review_dismissed';

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
  /**
   * The revision the payload was built for. Root-comment evidence is only
   * terminal when it names this SHA, so the adapter cannot classify without it.
   */
  targetRevision?: string;
  /** Trusted Codex root PR comments, oldest-first. */
  rootComments?: CodexGitHubRootCommentPayload[];
  /**
   * The root-comment fetch failed. Distinct from an empty `rootComments`: a
   * failed read is missing evidence, not absent evidence, so it must not be
   * silently overridden by an otherwise clean review.
   */
  rootCommentsUnavailable?: boolean;
  /** Why the payload is unusable, when `unavailable` is set. */
  unavailableReason?: CodexGitHubUnavailableReason;
};

export type LoadCodexGitHubReview = (
  ctx: ExternalReviewContext,
) => Promise<CodexGitHubReviewPayload | null> | CodexGitHubReviewPayload | null;
