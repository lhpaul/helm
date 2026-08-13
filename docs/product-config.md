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
count. Without it, an item can run dozens of cycles and never escalate.

`max_cycles_cumulative` is optional and defaults to `max_cycles * 3`. It must be
greater than or equal to `max_cycles` — a lifetime budget smaller than one
burst is rejected at config parse time.

The ledger is kept per **lane** (`code-review`, `spec-draft`, `plan-draft`), so
a chatty draft review never spends the implementation PR's budget. The
`no_progress` streak is carried across dispatches on the same ledger, so a
re-dispatch can no longer launder a stalled remediation loop.

When either budget is exhausted with blockers still open, the loop escalates:
the job reports `escalated: true` with `escalationReason`, and Helm posts the
review-loop escalation comment on the PR. Raising `max_cycles_cumulative` is the
way to grant an escalated item more budget — that is a human decision by design.

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
