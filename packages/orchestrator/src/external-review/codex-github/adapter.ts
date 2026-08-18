import { createHash } from 'node:crypto';
import { DEFAULT_CODEX_GITHUB_BLOCKING_SEVERITIES, type Product } from '@helm/shared';
import type {
  ExternalReviewAdapter,
  ExternalReviewContext,
  ExternalReviewResult,
  NormalizedFinding,
} from '../types.js';
import type {
  CodexGitHubReviewCommentPayload,
  CodexGitHubReviewConfig,
  CodexGitHubReviewPayload,
  CodexGitHubReviewSummaryPayload,
  CodexGitHubReviewThreadPayload,
  CodexGitHubRootCommentPayload,
  CodexGitHubSeverity,
  CodexGitHubUnavailableReason,
  LoadCodexGitHubReview,
} from './types.js';
import { classifyCodexRootComment } from './root-comment.js';

export type CodexGitHubAdapterDeps = {
  loadCodexGitHubReview?: LoadCodexGitHubReview;
};

const DEFAULT_DEFER_WHEN_PENDING = true;
const SEVERITIES: CodexGitHubSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Codex only posts what it considers high-priority (P0/P1), so an unlabeled
 * finding safe-fails to `high` rather than to the mid default the other
 * providers use — an unparsed label must not silently demote a real blocker.
 */
const UNLABELED_SEVERITY: CodexGitHubSeverity = 'high';

/** Codex's P-priority scale, as it appears in review comment bodies. */
const PRIORITY_SEVERITIES: Record<string, CodexGitHubSeverity> = {
  '0': 'critical',
  '1': 'high',
  '2': 'medium',
  '3': 'low',
};

export function resolveCodexGitHubReviewConfig(product: Product): CodexGitHubReviewConfig {
  return {
    blockingSeverities: product.review?.external?.codex_github?.blocking_severities ?? [
      ...DEFAULT_CODEX_GITHUB_BLOCKING_SEVERITIES,
    ],
    deferWhenPending: product.review?.external?.defer_when_pending ?? DEFAULT_DEFER_WHEN_PENDING,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSeverity(value: string | undefined): CodexGitHubSeverity {
  const normalized = value?.trim().toLowerCase();
  if (normalized && (SEVERITIES as string[]).includes(normalized)) {
    return normalized as CodexGitHubSeverity;
  }
  if (normalized === 'blocker' || normalized === 'major') return 'high';
  if (normalized === 'minor' || normalized === 'nit' || normalized === 'nitpick') return 'low';
  if (normalized === 'notice' || normalized === 'trivial') return 'info';
  return UNLABELED_SEVERITY;
}

function severityFromBody(body: string | undefined): CodexGitHubSeverity {
  if (!body) return UNLABELED_SEVERITY;
  // Codex's own scale first — `[P1]`, `P1:`, `**P1**`, `Priority: P1`.
  const priorityMatch = body.match(/\bP\s?([0-3])\b/i);
  if (priorityMatch?.[1]) {
    const mapped = PRIORITY_SEVERITIES[priorityMatch[1]];
    if (mapped) return mapped;
  }
  const markdownMatch = body.match(
    /\*\*\s*(critical|high|medium|low|info|blocker|major|minor|nitpick|nit)\s*\*\*/i,
  );
  if (markdownMatch?.[1]) return normalizeSeverity(markdownMatch[1]);
  const labelMatch = body.match(
    /\b(?:severity|priority)\s*[:=-]\s*(critical|high|medium|low|info|blocker|major|minor)\b/i,
  );
  if (labelMatch?.[1]) return normalizeSeverity(labelMatch[1]);
  return UNLABELED_SEVERITY;
}

function summarize(body: string | undefined, fallback: string): string {
  if (!body) return fallback;
  const firstLine = body
    .split('\n')
    .map((line) =>
      line
        .replace(/\*\*/g, '')
        .replace(/^[-*]\s*/, '')
        .replace(/^<!--[\s\S]*?-->/g, '')
        .trim(),
    )
    .find((line) => line.length > 0 && !line.startsWith('<'));
  if (!firstLine) return fallback;
  return firstLine.slice(0, 180);
}

/**
 * Codex's "nothing to flag" phrasings, as a **whole-body** verdict.
 *
 * Anchored on purpose: an unanchored scan drops any real finding that merely
 * mentions the phrase — `[P1] Validator reports no issues for malformed input`
 * is a blocker, not a verdict — and a dropped P1 on a `COMMENTED` review reads
 * back as `clean`. Only a comment that says nothing *but* the verdict qualifies,
 * and a parsed P-label vetoes it outright.
 */
function isNonActionableBody(body: string): boolean {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return false;
  // A finding that carried a priority label is a finding, whatever else it says.
  if (/\bP\s?[0-3]\b/i.test(stripped)) return false;
  return (
    /^(?:i\s+)?(?:found|see|have)?\s*no\s+(?:major\s+|actionable\s+|significant\s+|blocking\s+)?(?:issues|comments|findings|problems)(?:\s+(?:found|here|to\s+(?:flag|report)))?[.!]?$/i.test(
      stripped,
    ) ||
    /^(?:i\s+)?didn'?t\s+find\s+any\s+(?:major\s+)?(?:issues|problems)(?:\s+(?:here|with\s+this\s+change))?[.!]?$/i.test(
      stripped,
    )
  );
}

function stableCodexGitHubFindingId(input: {
  nativeId?: string;
  path?: string;
  line?: number;
  summary: string;
}): string {
  const source = [input.nativeId, input.path, input.line, input.summary]
    .map((part) => `${part ?? ''}`)
    .join('\0');
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `codex-github:${digest}`;
}

function makeFinding(
  input: {
    nativeId?: string;
    path?: string | null;
    line?: number | null;
    summary: string;
    detail?: string;
    severity: CodexGitHubSeverity;
  },
  config: CodexGitHubReviewConfig,
): NormalizedFinding {
  const path = text(input.path ?? undefined);
  const line = typeof input.line === 'number' ? input.line : undefined;
  const summary = text(input.summary) ?? 'Codex finding';
  const blocking = config.blockingSeverities.includes(input.severity);
  return {
    id: stableCodexGitHubFindingId({ nativeId: input.nativeId, path, line, summary }),
    severity: input.severity,
    blocking,
    path,
    summary,
    detail: text(input.detail),
  };
}

function findingFromComment(
  comment: CodexGitHubReviewCommentPayload,
  config: CodexGitHubReviewConfig,
  thread?: CodexGitHubReviewThreadPayload,
): NormalizedFinding | null {
  const body = text(comment.body);
  if (!body) return null;
  if (isNonActionableBody(body)) return null;
  const fallbackNativeId = text(`${comment.id ?? thread?.id ?? ''}`);
  return makeFinding(
    {
      nativeId: text(comment.node_id) ?? fallbackNativeId,
      path: comment.path ?? thread?.path,
      line: comment.line ?? comment.original_line ?? thread?.line,
      summary: summarize(body, 'Codex review comment'),
      detail: body,
      severity: severityFromBody(body),
    },
    config,
  );
}

/**
 * A `CHANGES_REQUESTED` review with no surviving inline finding still blocks —
 * the verdict itself is the blocker, so the loop never clears on a review that
 * explicitly asked for changes.
 */
function findingFromChangesRequested(
  review: CodexGitHubReviewSummaryPayload,
  config: CodexGitHubReviewConfig,
): NormalizedFinding {
  const body = text(review.body ?? undefined);
  return makeFinding(
    {
      nativeId: `review:${review.node_id ?? review.id ?? 'codex'}:changes_requested`,
      summary: body ? summarize(body, 'Codex requested changes') : 'Codex requested changes',
      detail: body,
      severity: body ? severityFromBody(body) : UNLABELED_SEVERITY,
    },
    config,
  );
}

function appendFinding(
  finding: NormalizedFinding,
  target: { blockers: NormalizedFinding[]; advisories: NormalizedFinding[] },
  seen: Set<string>,
): void {
  if (seen.has(finding.id)) return;
  seen.add(finding.id);
  if (finding.blocking) target.blockers.push(finding);
  else target.advisories.push(finding);
}

function isCheckRunInFlight(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return (
    normalized !== undefined && ['queued', 'pending', 'in_progress', 'waiting'].includes(normalized)
  );
}

/**
 * One piece of head-pinned evidence, ready to be ranked against the others.
 *
 * `rank` encodes the tie-break helm#96 requires: when two pieces of evidence
 * carry the same timestamp, anything that is not a clean approval wins, so an
 * actionable finding can never be hidden behind a same-second clean summary.
 */
type EvidenceRecord = {
  at: number;
  rank: 0 | 1 | 2;
  result: ExternalReviewResult;
};

const RANK_CLEAN = 0;
const RANK_UNAVAILABLE = 1;
const RANK_BLOCKING = 2;

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function unavailable(reason: CodexGitHubUnavailableReason): ExternalReviewResult {
  return { status: 'skipped', reason: 'unavailable', providerReason: reason };
}

/** Advisories from every clean record, de-duplicated by finding id. */
function mergeAdvisories(records: EvidenceRecord[]): NormalizedFinding[] {
  const merged: NormalizedFinding[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.result.status !== 'clean') continue;
    for (const advisory of record.result.advisories) {
      if (seen.has(advisory.id)) continue;
      seen.add(advisory.id);
      merged.push(advisory);
    }
  }
  return merged;
}

/** Newest wins; on an exact tie the higher rank (less clean) wins. */
function pickWinner(records: EvidenceRecord[]): EvidenceRecord | undefined {
  return records.reduce<EvidenceRecord | undefined>((best, candidate) => {
    if (!best) return candidate;
    if (candidate.at > best.at) return candidate;
    if (candidate.at === best.at && candidate.rank > best.rank) return candidate;
    return best;
  }, undefined);
}

function collectReviewFindings(
  payload: CodexGitHubReviewPayload,
  config: CodexGitHubReviewConfig,
): { blockers: NormalizedFinding[]; advisories: NormalizedFinding[] } {
  const findings = { blockers: [] as NormalizedFinding[], advisories: [] as NormalizedFinding[] };
  const seen = new Set<string>();

  for (const thread of payload.reviewThreads ?? []) {
    const resolved = thread.isResolved ?? thread.is_resolved ?? false;
    for (const comment of thread.comments ?? []) {
      const finding = findingFromComment(comment, config, thread);
      if (!finding) continue;
      if (resolved) {
        // Reserve the id so the same comment arriving via the REST list below
        // cannot resurrect a finding the author already resolved.
        seen.add(finding.id);
      } else {
        appendFinding(finding, findings, seen);
      }
    }
  }
  for (const comment of payload.reviewComments ?? []) {
    const finding = findingFromComment(comment, config);
    if (finding) appendFinding(finding, findings, seen);
  }
  return findings;
}

/** The verdict carried by the submitted review for the target revision. */
function reviewEvidence(
  payload: CodexGitHubReviewPayload,
  config: CodexGitHubReviewConfig,
): EvidenceRecord | undefined {
  // `reviewPending` is the loader saying it looked and found nothing submitted
  // for this revision; never read a review object alongside it.
  if (payload.reviewPending) return undefined;
  const review = payload.review;
  if (!review) return undefined;
  const at = timestamp(review.submitted_at);
  const reviewState = text(review.state)?.toUpperCase();

  // A dismissed review is withdrawn evidence, never a pass — but it is dated,
  // so a newer root-comment summary can still supersede it.
  if (reviewState === 'DISMISSED') {
    return { at, rank: RANK_UNAVAILABLE, result: unavailable('review_dismissed') };
  }

  const findings = collectReviewFindings(payload, config);
  if (findings.blockers.length > 0) {
    return {
      at,
      rank: RANK_BLOCKING,
      result: {
        status: 'needs_fixes',
        blockers: findings.blockers,
        advisories: findings.advisories,
      },
    };
  }

  if (reviewState === 'CHANGES_REQUESTED') {
    const finding = findingFromChangesRequested(review, config);
    return {
      at,
      rank: RANK_BLOCKING,
      result: {
        status: 'needs_fixes',
        blockers: [{ ...finding, blocking: true }],
        advisories: findings.advisories,
      },
    };
  }

  return {
    at,
    rank: RANK_CLEAN,
    result: { status: 'clean', blockers: [], advisories: findings.advisories },
  };
}

/**
 * A SHA-pinned root comment blocks on its own: Codex writes the finding into the
 * summary body when it has no inline thread to hang it on.
 */
function findingFromRootComment(
  comment: CodexGitHubRootCommentPayload,
  config: CodexGitHubReviewConfig,
): NormalizedFinding {
  const body = text(comment.body ?? undefined);
  return makeFinding(
    {
      nativeId: `root_comment:${comment.node_id ?? comment.id ?? 'codex'}`,
      summary: body
        ? summarize(body, 'Codex reported a blocking finding')
        : 'Codex reported a blocking finding',
      detail: body,
      severity: body ? severityFromBody(body) : UNLABELED_SEVERITY,
    },
    config,
  );
}

type RootCommentEvidence = {
  records: EvidenceRecord[];
  usageLimit: boolean;
};

/**
 * Reads the trusted Codex root PR comments into ranked evidence.
 *
 * This is the channel that gives a *clean* Codex run a terminal signal at all
 * (helm#96): a submitted review is the strongest evidence but Codex does not
 * always publish one, while it does reliably post a summary naming the commit
 * it reviewed.
 */
function rootCommentEvidence(
  payload: CodexGitHubReviewPayload,
  config: CodexGitHubReviewConfig,
): RootCommentEvidence {
  const records: EvidenceRecord[] = [];
  let usageLimit = false;

  for (const comment of payload.rootComments ?? []) {
    const classification = classifyCodexRootComment({
      body: comment.body,
      targetRevision: payload.targetRevision,
    });
    const at = timestamp(comment.created_at);

    if (classification.kind === 'usage_limit') {
      usageLimit = true;
      continue;
    }
    if (classification.kind === 'environment_missing') {
      records.push({ at, rank: RANK_UNAVAILABLE, result: unavailable('environment_missing') });
      continue;
    }
    if (classification.kind !== 'terminal') continue;

    if (classification.verdict === 'blocking' || classification.verdict === 'advisory') {
      const finding = findingFromRootComment(comment, config);
      // An explicit blocker blocks regardless of the parsed label; a P2/P3-only
      // summary defers to the configured `blocking_severities`, exactly as the
      // same finding would if Codex had posted it as an inline comment.
      const blocks = classification.verdict === 'blocking' || finding.blocking;
      records.push(
        blocks
          ? {
              at,
              rank: RANK_BLOCKING,
              result: {
                status: 'needs_fixes',
                blockers: [{ ...finding, blocking: true }],
                advisories: [],
              },
            }
          : {
              at,
              rank: RANK_CLEAN,
              result: { status: 'clean', blockers: [], advisories: [finding] },
            },
      );
      continue;
    }
    if (classification.verdict === 'clean') {
      records.push({
        at,
        rank: RANK_CLEAN,
        result: { status: 'clean', blockers: [], advisories: [] },
      });
      continue;
    }
    // Pinned to this head but unparseable: ambiguous, so unavailable — never clean.
    records.push({
      at,
      rank: RANK_UNAVAILABLE,
      result: unavailable('unrecognized_terminal_response'),
    });
  }

  return { records, usageLimit };
}

/**
 * Resolves Codex's evidence for the target revision into one verdict (ADR-036,
 * helm#96).
 *
 * Precedence, in order:
 *  1. **Blocking evidence always wins**, whatever its age and whatever else is
 *     present — an actionable finding must never hide behind an "unavailable".
 *  2. A **usage-limit** notice stops the invocation: once quota is exhausted a
 *     useful review is not going to arrive moments later.
 *  3. A **failed root-comment fetch** is missing evidence, not absent evidence,
 *     so a clean submitted review cannot silently override it.
 *  4. Otherwise the **newest** terminal evidence wins; on an exact timestamp
 *     tie the less-clean one does.
 */
export function normalizeCodexGitHubReviewPayload(
  payload: CodexGitHubReviewPayload,
  config: CodexGitHubReviewConfig,
): ExternalReviewResult {
  if (payload.unavailable) {
    return payload.unavailableReason
      ? unavailable(payload.unavailableReason)
      : { status: 'skipped', reason: 'unavailable' };
  }
  if (payload.error) return { status: 'escalate', reason: `codex-github ${payload.error}` };

  const deferOrEscalate = (providerReason: string): ExternalReviewResult =>
    config.deferWhenPending
      ? { status: 'deferred', reason: 'analysis_pending', providerReason }
      : { status: 'escalate', reason: providerReason };

  const roots = rootCommentEvidence(payload, config);
  const records = [...roots.records];
  const fromReview = reviewEvidence(payload, config);
  if (fromReview) records.push(fromReview);

  const blocking = pickWinner(records.filter((record) => record.rank === RANK_BLOCKING));
  if (blocking) return blocking.result;

  if (roots.usageLimit) return unavailable('usage_limit');
  if (payload.rootCommentsUnavailable) return unavailable('root_comments_unavailable');

  const winner = pickWinner(records);
  if (winner?.result.status === 'clean') {
    // The summary comment carries no inline advisories of its own, so when it
    // outranks a clean review the review's P2/P3 findings would vanish from the
    // post-clean disposition summary. Carry every clean record's advisories.
    return {
      status: 'clean',
      blockers: [],
      advisories: mergeAdvisories(records),
    };
  }
  if (winner) return winner.result;

  // No evidence at all for this revision. Unlike a status-driven provider there
  // is no pending signal to read, so waiting is the only way the verdict is ever
  // picked up — the deferred intent is resumed by the review or comment webhook,
  // or expires with `max_defer_sec`.
  const checkRun = payload.checkRun;
  if (isCheckRunInFlight(checkRun?.status)) {
    return deferOrEscalate(`codex-github check_run ${checkRun?.status}`);
  }
  return deferOrEscalate('codex-github review pending');
}

/** Codex GitHub external review adapter (ADR-036). */
export class CodexGitHubExternalReviewAdapter implements ExternalReviewAdapter {
  readonly provider = 'codex-github';

  constructor(
    private readonly product: Product,
    private readonly deps: CodexGitHubAdapterDeps = {},
  ) {}

  async reviewPullRequest(ctx: ExternalReviewContext): Promise<ExternalReviewResult> {
    if (!this.deps.loadCodexGitHubReview) {
      return { status: 'skipped', reason: 'unavailable' };
    }
    const payload = await this.deps.loadCodexGitHubReview(ctx);
    if (!payload) return { status: 'skipped', reason: 'unavailable' };
    return normalizeCodexGitHubReviewPayload(payload, resolveCodexGitHubReviewConfig(this.product));
  }
}

export function createCodexGitHubExternalReviewAdapter(
  product: Product,
  deps?: CodexGitHubAdapterDeps,
): CodexGitHubExternalReviewAdapter {
  return new CodexGitHubExternalReviewAdapter(product, deps);
}
