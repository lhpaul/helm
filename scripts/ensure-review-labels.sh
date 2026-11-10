#!/usr/bin/env bash
# Ensure the GitHub labels required by the review merge gate exist (#128).
# Creates missing labels only; never edits, renames or deletes existing ones.
# Usage:
#   ./scripts/ensure-review-labels.sh [--repo owner/name] [--dry-run]
set -euo pipefail

REPO=lhpaul/helm
DRY_RUN=0

# Required labels: name|color|description
REQUIRED_LABELS=(
  "ready-for-human-review|0e8a16|Reviewer loop clean at current head; awaiting human/Helm Dev merge"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo "Error: --repo requires a value" >&2
        exit 1
      fi
      REPO="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '2,5p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

existing=$(gh label list --repo "$REPO" --limit 1000 --json name --jq '.[].name')

for entry in "${REQUIRED_LABELS[@]}"; do
  IFS='|' read -r name color description <<<"$entry"
  if grep -Fxqi -- "$name" <<<"$existing"; then
    echo "ok: $name exists"
    continue
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "would create: $name"
    continue
  fi
  gh label create "$name" --repo "$REPO" --color "$color" --description "$description"
  echo "created: $name"
done
