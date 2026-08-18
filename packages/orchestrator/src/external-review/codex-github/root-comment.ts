/**
 * Classification of Codex GitHub **root PR comments** (ADR-036, helm#96).
 *
 * Codex's submitted review is its strongest completion signal, but it is not the
 * only one: a run that finds nothing frequently ends as a root PR comment that
 * names the revision it looked at, and a misconfigured or rate-limited run ends
 * as a root comment too. Reading those comments is what gives Helm a terminal
 * verdict for a *clean* Codex run — without it a clean PR sits deferred until
 * its intent expires (the gap documented on helm#96).
 *
 * The trust rule is the same one the rest of the provider uses: a root comment
 * is terminal **only** when it names the exact revision under review. Everything
 * else Codex posts — acknowledgements, progress notes, a 👍 reaction (which
 * carries no body at all and is therefore never even seen here) — is ancillary
 * and can never produce a clean verdict.
 */

/** How a trusted Codex root PR comment reads. */
export type CodexRootCommentClassification =
  /** Codex reported its own quota exhausted. Unavailable, and a hard stop. */
  | { kind: 'usage_limit' }
  /** Codex has no cloud environment for this repo. Unavailable, supersedable. */
  | { kind: 'environment_missing' }
  /** SHA-pinned to the revision under review — the only terminal comment shape. */
  | { kind: 'terminal'; reviewedSha: string; verdict: CodexRootCommentVerdict }
  /** Acknowledgement, progress note, or anything not pinned to this revision. */
  | { kind: 'ancillary' };

/**
 * `unrecognized` is deliberately **not** folded into `clean`: a SHA-pinned
 * response Helm cannot parse is ambiguous evidence, and helm#96 requires
 * ambiguous evidence to read as unavailable rather than clean.
 *
 * `advisory` separates "Codex labelled a P2/P3 and nothing else" from an
 * outright blocker, so a nit in the summary comment lands on the advisory list
 * exactly as the same nit does when it arrives as an inline comment.
 */
export type CodexRootCommentVerdict = 'clean' | 'blocking' | 'advisory' | 'unrecognized';

const MIN_SHA_LENGTH = 7;

/**
 * The `Reviewed commit:` marker, whose SHA Codex renders inside backticks. The
 * SHA is often abbreviated, so callers compare it by prefix, not by equality.
 *
 * Built per call: a shared `/g` regex carries `lastIndex` between callers, and
 * a fresh object is cheaper to reason about than remembering to reset it.
 */
const reviewedCommitPattern = (): RegExp =>
  /reviewed\s+commit\s*:?[^`\n]*`\s*([0-9a-f]{7,40})\s*`/gi;

const USAGE_LIMIT_RE =
  /(reached\s+your\s+codex\s+usage\s+limits?|codex\s+usage\s+limits?\s+for\s+code\s+reviews?\s+(?:reached|exceeded|exhausted|hit|unavailable|limited)|codex\s+(?:github\s+app\s+)?(?:review\s+)?(?:usage\s+limit|quota|capacity)\s+(?:reached|exceeded|exhausted|hit|unavailable|limited)|codex\s+review\s+capacity\s+(?:exhausted|unavailable|limited))/i;

const ENVIRONMENT_MISSING_RE =
  /to\s+use\s+codex\s+here,?\s+create\s+an\s+environment\s+for\s+this\s+repo/i;

const BLOCKING_RE =
  /(changes\s+requested|blocking\s+issues?\s*:|blocking\s+finding|blocking:|must\s+fix|action\s+required|required:|❌)/i;

const PRIORITY_LABEL_RE = /\bP\s?[0-3]\b/i;

/** Priorities Codex only assigns to something it wants changed. */
const BLOCKING_PRIORITY_LABEL_RE = /\bP\s?[01]\b/i;

const APPROVAL_RE =
  /(\bapproved\b|\blgtm\b|\blooks\s+good\b|didn'?t\s+find\s+any\s+(?:major\s+)?issues|found\s+no\s+(?:major\s+|actionable\s+|significant\s+|blocking\s+)?issues|no\s+(?:major\s+|actionable\s+|significant\s+|blocking\s+)?issues(?:\s+found)?\b|no\s+blocking\s+(?:issues?|findings?)\b|nothing\s+to\s+flag)/i;

/**
 * Negations that flip an approval or a merge verb. Kept as one list so a new
 * phrasing is covered for both checks at once — enumerating them per call site
 * is what let "should not be merged" read as `looks good` upstream.
 */
const NEGATION_WORDS =
  "not|no|never|cannot|can'?t|won'?t|shouldn'?t|mustn'?t|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|without|refuse[sd]?|blocked\\s+from";

/** Up to three qualifier words may sit between the negation and its target. */
const NEGATION_WINDOW = "(?:\\s+[a-z'’-]+){0,3}\\s+";

const NEGATED_APPROVAL_RE = new RegExp(
  `\\b(?:${NEGATION_WORDS})\\b${NEGATION_WINDOW}(?:approved?|lgtm|looks\\s+good|mergeable)\\b`,
  'i',
);

const MERGE_REFUSAL_RE = new RegExp(
  `\\b(?:${NEGATION_WORDS})\\b${NEGATION_WINDOW}(?:be\\s+)?merge[ds]?\\b`,
  'i',
);

/** A 2+ backtick run or a 3+ tilde run — see `stripQuotedSpans`. */
const FENCE_MARKER_RE = /(`{2,}|~{3,})/;

/**
 * Removes fenced blocks and single-backtick code spans.
 *
 * A Codex review of *this* file quotes the very phrases classified below, so a
 * naive scan reads a clean review of the classifier as a usage-limit notice.
 * Stripping quoted spans removes the common case; `hasFenceMarker` below
 * refuses to classify what stripping cannot safely handle.
 */
export function stripQuotedSpans(body: string): string {
  return (
    body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/^\s*>.*$/gm, ' ')
      // Emphasis markers otherwise wedge themselves between a negation and its
      // target — "**not** yet approved" read as an approval until they were
      // dropped — and collapsing the whitespace lets the `\s+` patterns below
      // span what the markers left behind.
      .replace(/[*_]+/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

/**
 * Removes fenced blocks, block quotes, and multi-backtick spans, but **keeps**
 * single-backtick spans.
 *
 * Marker extraction needs the opposite treatment from prose classification: the
 * SHA lives inside a single-backtick span, so `stripQuotedSpans` would eat the
 * very thing being parsed. Quoting a marker must still not forge evidence — a
 * trusted Codex comment can quote one in a fence, a block quote, or a 2+
 * backtick span, and if unquoted approval prose follows, the quoted marker
 * would otherwise be promoted to clean evidence for the current head.
 */
function stripBlockQuotedSpans(body: string): string {
  return (
    body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/^\s*>.*$/gm, ' ')
      // A run of two or more backticks delimits a span that can itself contain
      // single-backtick content — a whole marker included.
      .replace(/(`{2,})[\s\S]*?\1/g, ' ')
      // Fail closed on an *unclosed* delimiter. The passes above only remove
      // matched pairs, so a comment that opens a fence and never closes it would
      // leave the marker inside it eligible — and Markdown renders an unclosed
      // fence as quoted through end of document anyway. Everything from the
      // first surviving run to the end is therefore treated as quoted. Single
      // backticks are untouched: that is where the SHA legitimately lives.
      .replace(/(?:```|~~~|`{2,})[\s\S]*$/, ' ')
  );
}

/**
 * True when the body still carries a multi-backtick or tilde run after
 * stripping. CommonMark lets a code span be delimited by an equal-length run of
 * two or more backticks, which the single-pair strip above leaves intact — so
 * rather than reimplement delimiter-run matching, a surviving run disqualifies
 * the body from the unavailability classifications entirely. Terminal SHA
 * pinning is unaffected: it is anchored on an explicit marker, not on prose.
 */
function hasFenceMarker(body: string): boolean {
  return FENCE_MARKER_RE.test(body);
}

/** Case-insensitive prefix match in either direction, for abbreviated SHAs. */
export function shaMatches(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = a?.trim().toLowerCase() ?? '';
  const right = b?.trim().toLowerCase() ?? '';
  if (left.length < MIN_SHA_LENGTH || right.length < MIN_SHA_LENGTH) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * The last `Reviewed commit` marker in the body's **unquoted** prose, if any.
 * A marker inside a fence, a block quote, or a multi-backtick span is not
 * evidence — see `stripBlockQuotedSpans`.
 */
export function reviewedCommitFromBody(body: string): string | undefined {
  let sha: string | undefined;
  for (const match of stripBlockQuotedSpans(body).matchAll(reviewedCommitPattern())) {
    if (match[1]) sha = match[1].toLowerCase();
  }
  return sha;
}

/** Reads the verdict of a body already known to be pinned to the target SHA. */
export function verdictFromRootCommentBody(body: string): CodexRootCommentVerdict {
  const prose = stripQuotedSpans(body);
  // Explicit blocking language and Codex's own P0/P1 both safe-fail to blocking,
  // whatever else the body says — including a lower label alongside them.
  if (
    BLOCKING_RE.test(prose) ||
    BLOCKING_PRIORITY_LABEL_RE.test(prose) ||
    MERGE_REFUSAL_RE.test(prose)
  ) {
    return 'blocking';
  }
  // A surviving P2/P3 is still a finding, just not one that blocks by itself.
  if (PRIORITY_LABEL_RE.test(prose)) return 'advisory';
  if (NEGATED_APPROVAL_RE.test(prose)) return 'unrecognized';
  if (APPROVAL_RE.test(prose)) return 'clean';
  return 'unrecognized';
}

/**
 * Classifies one trusted Codex root PR comment against the revision under
 * review. `targetRevision` may be abbreviated on either side.
 */
export function classifyCodexRootComment(input: {
  body: string | null | undefined;
  targetRevision: string | undefined;
}): CodexRootCommentClassification {
  const body = input.body?.trim();
  if (!body) return { kind: 'ancillary' };

  const reviewedSha = reviewedCommitFromBody(body);
  const pinned = reviewedSha !== undefined && shaMatches(reviewedSha, input.targetRevision);
  const verdict = pinned ? verdictFromRootCommentBody(body) : undefined;

  // Blocking outranks everything, so a pinned finding is returned before the
  // unavailability wording is even consulted — Codex reporting a blocker and
  // its own quota in one comment must still surface the blocker.
  if (pinned && verdict === 'blocking') {
    return { kind: 'terminal', reviewedSha: reviewedSha!, verdict };
  }

  // Unavailability wording is prose, so it is only read outside quoted spans —
  // and not at all when a delimiter run makes stripping unreliable. Checked
  // before the remaining pinned verdicts: a head-pinned response that reports
  // exhausted quota is a usage limit, not an unparseable verdict.
  if (!hasFenceMarker(body)) {
    const prose = stripQuotedSpans(body);
    if (USAGE_LIMIT_RE.test(prose)) return { kind: 'usage_limit' };
    if (ENVIRONMENT_MISSING_RE.test(prose)) return { kind: 'environment_missing' };
  }

  if (pinned) return { kind: 'terminal', reviewedSha: reviewedSha!, verdict: verdict! };

  // Pinned to a *different* revision, or not pinned at all: acknowledgement
  // only. A stale summary must never clear the current head.
  return { kind: 'ancillary' };
}
