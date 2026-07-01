#!/usr/bin/env bash
# Resolves op:// references from .env.template via 1Password CLI and writes apps/api/.env.
# Local paths and optional overrides come from .env.local (see .env.local.example).
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${API_DIR}/.env.template"
LOCAL="${API_DIR}/.env.local"
OUTPUT="${API_DIR}/.env"

if ! command -v op >/dev/null 2>&1; then
  echo "Error: 1Password CLI (op) not found." >&2
  echo "Install: https://developer.1password.com/docs/cli/get-started/" >&2
  exit 1
fi

if ! op account list >/dev/null 2>&1; then
  echo "Error: 1Password CLI is not signed in. Run: op signin" >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Error: Missing ${TEMPLATE}" >&2
  exit 1
fi

if [[ ! -f "$LOCAL" ]]; then
  echo "Warning: ${LOCAL} not found." >&2
  echo "  Copy .env.local.example → .env.local and set HELM_KNOWLEDGE_REPO_PATH / HELM_DATA_DIR." >&2
fi

COMBINED="$(mktemp)"
trap 'rm -f "$COMBINED"' EXIT

{
  cat "$TEMPLATE"
  if [[ -f "$LOCAL" ]]; then
    printf '\n# --- local overrides (.env.local) ---\n'
    cat "$LOCAL"
  fi
} >"$COMBINED"

op inject -i "$COMBINED" -o "$OUTPUT" --force

UNRESOLVED="$(grep -E '^(LINEAR_API_KEY|GITHUB_WEBHOOK_SECRET|GITHUB_TOKEN)=op://' "$OUTPUT" || true)"
if [[ -n "$UNRESOLVED" ]]; then
  echo "Error: Some op:// references were not resolved:" >&2
  echo "$UNRESOLVED" >&2
  exit 1
fi

if ! grep -qE '^HELM_KNOWLEDGE_REPO_PATH=.+$' "$OUTPUT"; then
  echo "Error: HELM_KNOWLEDGE_REPO_PATH is missing or empty in ${OUTPUT}." >&2
  echo "  Set it in .env.local before running sync-env." >&2
  exit 1
fi

echo "Wrote ${OUTPUT}"
echo "Restart the API (pnpm dev) if it is already running."
