import type { ReviewLoopLedger } from '@helm/orchestrator';
import type { WorkflowStage } from '@helm/workflow';

/**
 * Validates externalId values for safe filesystem use.
 * Allows standard tracker formats: MOM-142, HLM-7, issue_3, feature.v2
 * Blocks: slashes, backslashes, spaces, leading dots, and other specials.
 *
 * Single source of truth — imported by both ItemStore and route handlers
 * so the validation stays in sync.
 */
export const EXTERNAL_ID_REGEX = /^(?!\.)[A-Za-z0-9._-]+$/;

/**
 * Character allowlist for filesystem path inputs — rejects spaces, shell
 * metacharacters, and control characters. It does NOT, on its own, prevent
 * path traversal: `.` and `..` are valid characters, so `../x` matches.
 * Use {@link isSafeFsPath} for the full check.
 */
export const SAFE_FS_PATH_REGEX = /^[A-Za-z0-9._/\-]+$/;

/**
 * Validates filesystem path inputs taken from env vars
 * (`HELM_KNOWLEDGE_REPO_PATH`, `HELM_DATA_DIR`) before they are joined into
 * filesystem operations. Combines the character allowlist with a path-segment
 * check that rejects `.` and `..` segments, so a value cannot resolve to the
 * current working directory or escape the intended directory tree.
 *
 * Single source of truth — shared by the product registry loader and the CLI
 * scripts (sync, writeback-backfill) so the path-safety check cannot drift.
 */
export function isSafeFsPath(value: string): boolean {
  if (!SAFE_FS_PATH_REGEX.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment, index) => {
    // Allow only a single leading empty segment — the '/' that starts an absolute
    // path ('/abs/path'). Reject the bare root ('/'), trailing and consecutive
    // slashes ('data/', 'a//b'), and '.'/'..' traversal segments.
    if (segment === '') return index === 0;
    return segment !== '.' && segment !== '..';
  });
}

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
  /**
   * Server-owned replay marker for idempotent transitions (e.g. merge
   * reconciliation). Never accepted from client request bodies — only set by
   * internal callers of {@link ItemStore.transitionIfCurrentStage}.
   */
  idempotencyKey?: string;
};

export type ResolvedProductDecision = {
  fingerprint: string;
  conflictKind: 'product_decision' | 'doc_conflict';
  conflictTitle: string;
  scope: {
    paths: string[];
    markers: string[];
  };
  chosenOption: string;
  source: {
    provider: 'github';
    owner: string;
    repo: string;
    prNumber: number;
    commentId?: number;
    authorLogin: string;
  };
  /** ISO 8601 timestamp */
  recordedAt: string;
};

/**
 * A finding a maintainer dismissed on this item via the `helm:accept-finding`
 * PR comment (ADR-043 §4). Scoped to one item — a pattern worth suppressing
 * product-wide belongs in the knowledge repo's `false-positives.md`.
 */
export type AcceptedFinding = {
  /** ADR-038 fingerprint of the finding title — what the review loop matches on. */
  fingerprint: string;
  findingTitle: string;
  /** Uppercased; only MEDIUM and below can be accepted. */
  severity: string;
  rationale: string;
  source: {
    provider: 'github';
    owner: string;
    repo: string;
    prNumber: number;
    commentId?: number;
    authorLogin: string;
  };
  /** ISO 8601 timestamp */
  recordedAt: string;
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
  /** Durable ledger of human-resolved review adjudication decisions. */
  resolvedProductDecisions?: ResolvedProductDecision[];
  /** Durable ledger of findings a maintainer accepted on this item (ADR-043 §4). */
  acceptedFindings?: AcceptedFinding[];
  /**
   * Lifetime review/remediation counters per loop lane (ADR-042). Survives
   * re-dispatch so `max_cycles` cannot be reset by dispatching again.
   */
  reviewLoopLedger?: ReviewLoopLedger;
  /** ISO 8601 — set on creation, never changes */
  createdAt: string;
  /** ISO 8601 — updated on every transition */
  updatedAt: string;
};
