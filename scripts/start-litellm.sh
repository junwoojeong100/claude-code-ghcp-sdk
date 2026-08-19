#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LITELLM_BIN="$ROOT_DIR/.runtime/litellm-venv/bin/litellm"
KEY_FILE="$ROOT_DIR/.runtime/litellm-master-key"
CONFIG_FILE="$ROOT_DIR/examples/litellm-github-copilot.yaml"
HOST="${LITELLM_HOST:-127.0.0.1}"
PORT="${LITELLM_PORT:-4000}"
TOKEN_DIR="${GITHUB_COPILOT_TOKEN_DIR:-$HOME/.config/litellm/github_copilot}"

[[ -x "$LITELLM_BIN" ]] || {
  echo "LiteLLM runtime is missing: $LITELLM_BIN" >&2
  exit 1
}
[[ -r "$KEY_FILE" ]] || {
  echo "LiteLLM master key is missing: $KEY_FILE" >&2
  exit 1
}

for credential_file in "$TOKEN_DIR/access-token" "$TOKEN_DIR/api-key.json"; do
  [[ -f "$credential_file" ]] && chmod 600 "$credential_file"
done

export LITELLM_MASTER_KEY
LITELLM_MASTER_KEY="$(tr -d '\n' <"$KEY_FILE")"

exec "$LITELLM_BIN" \
  --config "$CONFIG_FILE" \
  --host "$HOST" \
  --port "$PORT"
