# Review merge-gate labels

The review loop's human merge gate is enabled by a GitHub label on the PR.
Helm never merges on its own; the label marks a PR whose reviewer loop is clean
at the current head and is awaiting a human (or Helm Dev) merge.

| Label                    | Color    | Meaning                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------ |
| `ready-for-human-review` | `0e8a16` | Reviewer loop clean at current head; awaiting human/Helm Dev merge |

This is the only gate-required label. `review-loop` and `adr-036` are
organizational and not required by the gate.

## Ensuring the labels exist

```bash
./scripts/ensure-review-labels.sh [--repo owner/name] [--dry-run]
```

- Creates any missing required label; reports `ok:` for those already present.
- Idempotent. Never edits, renames, recolors or deletes existing labels, and
  never touches branch protection or other repository settings.
- Needs the same `gh` auth that applies the label (label write on the repo).
- Run it before applying the gate label so nobody has to create it by hand.
  The label set is defined in `REQUIRED_LABELS` inside the script.
