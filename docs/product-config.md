# Product Configuration

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
