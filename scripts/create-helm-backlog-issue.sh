#!/usr/bin/env bash
# Create a Helm backlog issue in lhpaul/helm and add it to Project #3.
# Usage:
#   ./scripts/create-helm-backlog-issue.sh --title "..." --body-file path.md [--label enhancement] [--type Workflow]
set -euo pipefail

OWNER=lhpaul
REPO=helm
PROJECT_NUMBER=3
PROJECT_ID=PVT_kwHOABGFY84BXWgN
TYPE_FIELD_ID=PVTSSF_lAHOABGFY84BXWgNzhX0dIE

TITLE=""
BODY=""
BODY_FILE=""
TYPE="Workflow"
LABELS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --type) TYPE="$2"; shift 2 ;;
    --label) LABELS+=("$2"); shift 2 ;;
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

if [[ -z "$TITLE" ]]; then
  echo "--title is required" >&2
  exit 1
fi

if [[ -n "$BODY_FILE" ]]; then
  BODY=$(cat "$BODY_FILE")
elif [[ -z "$BODY" ]]; then
  BODY="(no description)"
fi

label_args=()
for label in "${LABELS[@]}"; do
  label_args+=(--label "$label")
done

url=$(gh issue create --repo "$OWNER/$REPO" --title "$TITLE" --body "$BODY" "${label_args[@]}")
echo "Created: $url"

gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" >/dev/null
echo "Added to https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"

# Resolve Type option id
case "$TYPE" in
  Feature) TYPE_OPT=b872b3f8 ;;
  Bug) TYPE_OPT=c8713ae4 ;;
  Refactor) TYPE_OPT=cd358f6c ;;
  Workflow) TYPE_OPT=30146078 ;;
  *)
    echo "Unknown --type $TYPE (Feature|Bug|Refactor|Workflow); skipping Type field" >&2
    exit 0
    ;;
esac

issue_number=${url##*/}
item_id=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --limit 100 --format json \
  --jq ".items[] | select(.content.number == $issue_number) | .id")

if [[ -n "$item_id" ]]; then
  gh project item-edit \
    --project-id "$PROJECT_ID" \
    --id "$item_id" \
    --field-id "$TYPE_FIELD_ID" \
    --single-select-option-id "$TYPE_OPT" >/dev/null
  echo "Set Type=$TYPE"
fi
