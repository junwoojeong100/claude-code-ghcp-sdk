#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LITELLM_BIN="$ROOT_DIR/.runtime/litellm-venv/bin/litellm"
KEY_FILE="$ROOT_DIR/.runtime/litellm-master-key"
CONFIG_FILE="${LITELLM_CONFIG:-$ROOT_DIR/examples/litellm-github-copilot.yaml}"
HOST="${LITELLM_HOST:-127.0.0.1}"
PORT="${LITELLM_PORT:-4000}"

[[ -x "$LITELLM_BIN" ]] || {
  echo "LiteLLM runtime is missing: $LITELLM_BIN" >&2
  echo "Run: npm run litellm:setup" >&2
  exit 1
}
[[ -r "$KEY_FILE" ]] || {
  echo "LiteLLM master key is missing: $KEY_FILE" >&2
  exit 1
}
[[ -r "$CONFIG_FILE" ]] || {
  echo "LiteLLM config is missing: $CONFIG_FILE" >&2
  exit 1
}

# The config resolves both of these through os.environ/ at load time, so an
# unset variable produces a gateway that accepts requests and cannot route them.
[[ -n "${GHCP_BRIDGE_URL:-}" ]] || {
  echo "GHCP_BRIDGE_URL is required: the bridge root, with no /v1 suffix." >&2
  echo "Start the bridge first: node src/bridge-daemon.mjs ensure <model> <port>" >&2
  exit 1
}
[[ -n "${GHCP_BRIDGE_TOKEN:-}" ]] || {
  echo "GHCP_BRIDGE_TOKEN is required: the token printed by bridge-daemon ensure." >&2
  echo "'status' never prints it; re-run 'ensure' or read the registry bridge.json." >&2
  exit 1
}

# LiteLLM appends /v1/messages to api_base, so a /v1 suffix here 404s the bridge.
case "${GHCP_BRIDGE_URL%/}" in
  */v1)
    echo "GHCP_BRIDGE_URL must not end in /v1; LiteLLM appends /v1/messages." >&2
    exit 1
    ;;
esac

export GHCP_BRIDGE_URL
export GHCP_BRIDGE_TOKEN
export LITELLM_MASTER_KEY
LITELLM_MASTER_KEY="$(tr -d '\n' <"$KEY_FILE")"

exec "$LITELLM_BIN" \
  --config "$CONFIG_FILE" \
  --host "$HOST" \
  --port "$PORT"
