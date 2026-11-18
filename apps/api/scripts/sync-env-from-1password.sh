#!/usr/bin/env bash
# Resolves op:// references from a product env file via 1Password CLI
# and writes apps/api/.env.
#
# Usage:
#   pnpm sync-env -- <product>
#   pnpm sync-env -- helm
#
# <product> must match ^[a-z0-9][a-z0-9-]*$ (at most 64 characters) and names
# the input file apps/api/.env.<product>. "example" is reserved for the
# committed template.
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${API_DIR}/.env"
# pnpm may forward a bare "--" before the product name.
PRODUCT="${1:-}"
if [[ "$PRODUCT" == "--" ]]; then
  PRODUCT="${2:-}"
fi

usage() {
  echo "Usage: pnpm sync-env -- <product>" >&2
  echo "  product: lowercase slug matching ^[a-z0-9][a-z0-9-]*\$ (max 64 chars), e.g. helm" >&2
  echo "  Reads apps/api/.env.<product> and writes apps/api/.env" >&2
}

if [[ -z "$PRODUCT" ]]; then
  usage
  exit 1
fi

# Validate strictly before the slug builds a path or reaches the secrets manager.
# Explicit character lists (not ranges) keep the check independent of locale.
invalid_slug() {
  echo "Error: invalid product slug." >&2
  usage
  exit 1
}
case "$PRODUCT" in
  -* | *[!abcdefghijklmnopqrstuvwxyz0123456789-]*) invalid_slug ;;
esac
if ((${#PRODUCT} > 64)); then
  invalid_slug
fi

if [[ "$PRODUCT" == "example" ]]; then
  echo "Error: 'example' is reserved for the .env.example template." >&2
  usage
  exit 1
fi

INPUT="${API_DIR}/.env.${PRODUCT}"

if ! command -v op >/dev/null 2>&1; then
  echo "Error: 1Password CLI (op) not found." >&2
  echo "Install: https://developer.1password.com/docs/cli/get-started/" >&2
  exit 1
fi

if ! op account list >/dev/null 2>&1; then
  echo "Error: 1Password CLI is not signed in. Run: op signin" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "Error: Missing ${INPUT}" >&2
  echo "  Copy the '${PRODUCT}' block from .env.example into that file and set your paths." >&2
  exit 1
fi

op inject -i "$INPUT" -o "$OUTPUT" --force

UNRESOLVED="$(grep -E '^[A-Z0-9_]+=op://' "$OUTPUT" || true)"
if [[ -n "$UNRESOLVED" ]]; then
  echo "Error: Some secret references were not resolved:" >&2
  echo "$UNRESOLVED" >&2
  exit 1
fi

if ! grep -qE '^HELM_KNOWLEDGE_REPO_PATH=.+$' "$OUTPUT"; then
  echo "Error: HELM_KNOWLEDGE_REPO_PATH is missing or empty in ${OUTPUT}." >&2
  exit 1
fi

if ! grep -qE '^HELM_DATA_DIR=.+$' "$OUTPUT"; then
  echo "Error: HELM_DATA_DIR is missing or empty in ${OUTPUT}." >&2
  exit 1
fi

if ! grep -qE '^GITHUB_TOKEN=.+$' "$OUTPUT"; then
  echo "Error: GITHUB_TOKEN is missing or empty in ${OUTPUT}." >&2
  exit 1
fi

echo "Product: ${PRODUCT}"
echo "Wrote ${OUTPUT} from ${INPUT}"
echo "Restart the API (pnpm dev) if it is already running."
