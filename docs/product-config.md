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
