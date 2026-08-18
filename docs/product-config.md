# Product Configuration

## Review Loop Budgets

The review loop is bounded by two independent limits (ADR-036, ADR-042):

```yaml
review:
  loop:
    max_cycles: 5 # per-dispatch burst limit
    max_cycles_cumulative: 15 # lifetime budget per item and lane
    stop_rule:
      no_progress_cycles: 2
```

`max_cycles` bounds a single dispatch — it is a cost guard on one run.
`max_cycles_cumulative` bounds the item's whole life: remediation passes are
counted in a durable per-item ledger, so re-dispatching (operator retry, PR
`synchronize` webhook, resumed deferred external review) does **not** reset the
count. Ledger writes are best effort: if a write fails, a later dispatch can
load stale counters. Cycles from a failed write are not recoverable after the
dispatch ends, so cumulative usage can remain undercounted.
Without the ledger, an item can run dozens of cycles and never escalate.

`max_cycles_cumulative` is optional and defaults to `max_cycles * 3`. It must be
greater than or equal to `max_cycles` — a lifetime budget smaller than one
burst is rejected at config parse time.

The ledger is kept per **lane** (`code-review`, `spec-draft`, `plan-draft`), so
a chatty draft review never spends the implementation PR's budget. The
`no_progress` streak is carried across dispatches on the same ledger, so a
re-dispatch can no longer launder a stalled remediation loop.

When either budget is exhausted with blockers still open, the loop escalates:
the job reports `escalated: true` with `escalationReason`, and Helm attempts
to post the review-loop escalation comment on the PR. Comment delivery is best
effort; operators should use the escalation result as the canonical signal.

### Clearing an exhausted lifetime budget

Nothing resets the ledger automatically. A re-dispatch after the budget is spent
still runs one reviewer fan-out — that is how Helm learns whether the blockers
are gone. If they are, the loop exits clean and never reaches the stop rule; the
fan-out is not a remediation pass and does not consume budget. If they are not,
it escalates again immediately instead of burning another remediation pass.

Granting an escalated item more budget is a human decision, by design. Two ways:

1. **Raise the budget** — increase `review.loop.max_cycles_cumulative` in the
   product's `.helm/product.yaml`. Applies to every item of that product.
2. **Clear one item's lane** — delete the lane key from `reviewLoopLedger` in
   `$HELM_DATA_DIR/items/<externalId>.json` (stop the API server first, since
   item writes are serialized in-process):

   ```jsonc
   {
     "reviewLoopLedger": {
       "code-review": { "cyclesTotal": 15, ... } // ← delete this lane
     }
   }
   ```

   The lane is recreated on the next completed remediation pass, starting from
   zero. Other lanes and the rest of the item state are untouched. The escalation
   stays in the item's `history` either way.

## External Review Providers

A product runs at most one external reviewer, selected by
`review.external.provider` (ADR-036). Omitting the block disables external
review entirely — the loop then runs on Helm's own reviewer fan-out.

| Provider       | Completion signal Helm trusts                          | Trust anchor                   |
| -------------- | ------------------------------------------------------ | ------------------------------ |
| `bugbot`       | check run with an allowlisted name                     | publishing GitHub App identity |
| `coderabbit`   | commit status with an allowlisted context              | status sender login            |
| `codex-github` | **submitted PR review** pinned to the exact commit SHA | review author login            |

Every provider is a name **and** identity check: a matching name from any other
app, or a matching identity on any other name, is ignored.

### `codex-github`

```yaml
review:
  external:
    provider: codex-github
    defer_when_pending: true
    resume_on_check_run: true
    codex_github:
      trusted_identities:
        # The `[bot]` login only — see the exact-matching note below.
        - 'chatgpt-codex-connector[bot]'
      check_names: # optional — only used to name an in-flight analysis
        - Codex
        - Codex Review
      blocking_severities:
        - critical
        - high
```

Codex publishes no commit status. It signals completion by **submitting a PR
review**, so Helm treats "a review authored by a trusted identity exists for the
target revision" as the readiness test, and resumes a deferred review from the
`pull_request_review` (`submitted`) webhook. A review for an older revision does
not resume anything — the SHA must match exactly.

Findings map from Codex's own P-scale: `P0 → critical`, `P1 → high`,
`P2 → medium`, `P3 → low`. An **unlabeled** comment is treated as `high`, not
`medium` — Codex only posts what it considers high-priority, so an unparsed
label must never silently demote a real blocker. A `CHANGES_REQUESTED` review
blocks even when every inline thread has been resolved.

Trusted-identity matching is exact for review authors: list the `[bot]` login,
since a human could register the un-suffixed one. Check-run **app** identities
are matched with the `[bot]` suffix ignored, because GitHub's app record carries
the bare slug and that value is not user-settable.

Only a **submitted** review counts. A draft (`PENDING`, `submitted_at` null) is
visible on the reviews endpoint before its author submits it and carries no
inline comments, so treating it as the verdict would forge a `clean` result;
Helm keeps deferring until the review is submitted.

**Operator prerequisite:** Codex reviews are not automatic by default. Either
enable _Automatic reviews_ in Codex's GitHub settings for the repo, or comment
`@codex review` on the PR. Without one of the two, no review is ever submitted:
Helm defers, and the pending intent expires after `review.external.max_defer_sec`
(default 30 minutes).

#### The clean-terminal contract

Helm returns `clean` for Codex only on evidence that is **all four** of:

1. **Attributable** — authored by a trusted identity (exact match for review and
   comment authors; only check-run **app** identities relax the `[bot]` suffix).
2. **Head-pinned** — a submitted review whose `commit_id` matches the revision
   under review, or a root PR comment whose `Reviewed commit:` marker names it.
   Abbreviated SHAs match by prefix.
3. **Terminal** — a verdict, not an acknowledgement. A 👍 reaction, a "starting
   a review" comment, and a draft (`PENDING`) review are not verdicts.
4. **Parseable as a pass** — the body reads as an explicit approval.

Findings in a summary comment follow the same severity rules as inline ones: an
explicit blocker (`must fix`, `changes requested`, a merge refusal) or a P0/P1
label blocks, while a P2/P3-only summary lands on the advisory list.

Root PR comments are the second evidence channel, and the one that gives a clean
Codex run a terminal signal at all: Codex publishes no check run or status and
does not always submit a review, but it does post a summary naming the commit it
reviewed.

When evidence disagrees: **blocking always wins**, whatever its age; then an
exhausted **usage limit**; then a **failed root-comment read** (missing evidence,
not absent evidence — a clean review cannot silently override it); otherwise the
**newest** wins, and on an exact timestamp tie the less-clean side does. So an
operator who creates the Codex environment mid-loop has the resulting fresh
review supersede the recorded environment error, while a later bare
acknowledgement never does.

#### What reads as unavailable, never clean

Reaction-only responses, stale reviews and stale summaries, draft reviews,
dismissed reviews, a missing Codex cloud environment (`To use Codex here, create
an environment for this repo`), an exhausted usage limit, a SHA-pinned response
Helm cannot parse, and a failed root-comment read. Each names its cause in the
`external_repeated_skip` escalation, so a quota stop is distinguishable from a
misconfiguration.

Unavailability wording is only read outside quoted spans, and a body carrying a
multi-backtick or 3+-tilde run is not classified at all — a Codex review of this
very section quotes the phrases the classifier matches on.

#### Resume path

A trusted root comment whose marker names a **full** 40-hex SHA resumes a
deferred intent from the `issue_comment` webhook, alongside the
`pull_request_review`/`submitted` path. An abbreviated marker cannot address a
pending intent (matched by exact revision); those runs are picked up on the next
poll instead.

> **Not the default yet.** The trusted clean signal above is implemented but has
> not been dogfooded on a real PR, so the dogfood product still runs
> `provider: coderabbit`. Promoting `codex-github` to a product's default is a
> separate, explicitly approved change — see ADR-036's 2026-08-18 addendum.

## Early Draft Review Loop

Products can opt in to external review before spec and plan artifacts are ready
for operator-authored remediation:

```yaml
review:
  early_loop:
    enabled: true
```

`review.early_loop.enabled` defaults to `false`. When the `review` section is
omitted, Helm materializes the parsed product config as:

```yaml
review:
  early_loop:
    enabled: false
```

This default-off contract is intentional for rollout safety. Existing products
keep their current operator-triggered `spec-remediator` and `plan-remediator`
flows unless they explicitly set the flag to `true`.

When enabled, the early loop applies only to knowledge-repo draft artifact PRs:

- `helm/spec/<externalId>` while the item is in `spec-draft`, routed through
  `spec-draft-reviewer`
- `helm/plan/<externalId>` while the item is in `plan-draft`, routed through
  `plan-draft-reviewer`

The loop runs on supported draft PR open/synchronize webhooks from the canonical
knowledge repo. It does not change implementation PR review, merge
reconciliation, or explicit operator remediation commands.
