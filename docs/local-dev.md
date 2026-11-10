# Local Dev Operations

## Recover A Missed Artifact PR Merge

Helm normally advances an item when GitHub delivers a merged pull request webhook
for an artifact branch:

- `helm/spec/<externalId>` advances `spec-draft` to `spec-ready`
- `helm/plan/<externalId>` advances `plan-draft` to `plan-ready`
- `helm/impl/<externalId>` advances `code-review` to `merged`

Use the recovery endpoint when webhook delivery is unavailable, a local/dev merge
was missed, or a prior automatic attempt failed before the item advanced:

```bash
curl -X POST "http://localhost:3000/api/items/HLM-1/merge-reconciliation" \
  -H "content-type: application/json" \
  -d '{"repository":{"owner":"lhpaul","repo":"helm"},"pullRequestNumber":123}'
```

The endpoint reads the current pull request state from GitHub, verifies that the
PR is merged and uses a supported artifact branch, then runs the same guarded
transition path as the webhook handler. Repeating the same request after success
is safe: Helm returns an already-reconciled no-op and does not append duplicate
history.

## Item storage layout

Workflow state is stored one JSON file per item at
`$HELM_DATA_DIR/items/<productSlug>/<externalId>.json`, so products sharing a data
root never collide on `externalId` (ADR-004). Older flat files
(`items/<externalId>.json`) are moved into their product directory automatically
the first time the server (or the writeback-backfill script) touches the store;
the move is idempotent and never overwrites an existing file. Files that cannot
be migrated safely (invalid JSON, missing/unsafe `productSlug`) stay in place and
are reported in the server log. To roll back, move the files from each
`items/<productSlug>/` directory back up into `items/`.
