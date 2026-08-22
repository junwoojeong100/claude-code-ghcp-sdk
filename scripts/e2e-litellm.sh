#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS_PATH="${HOME}/.claude/settings.json"
BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}"
MODEL="${LITELLM_MODEL:-claude-sonnet-5}"
KEY_FILE="${LITELLM_KEY_FILE:-$ROOT_DIR/.runtime/litellm-master-key}"
MARKER_PREFIX="CLAUDE_CODE_LITELLM"
FIXTURE="$(mktemp "${TMPDIR:-/tmp}/claude-litellm-fixture.XXXXXX")"

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT

if [[ -z "${LITELLM_API_KEY:-}" ]]; then
  [[ -r "$KEY_FILE" ]] || {
    echo "Set LITELLM_API_KEY or provide a readable LITELLM_KEY_FILE." >&2
    exit 1
  }
  LITELLM_API_KEY="$(tr -d '\n' <"$KEY_FILE")"
  export LITELLM_API_KEY
fi

export LITELLM_BASE_URL="$BASE_URL"
export LITELLM_MODEL="$MODEL"

BEFORE_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"
printf '%s_READ_TOOL_OK\n' "$MARKER_PREFIX" >"$FIXTURE"

curl --silent --show-error --fail --max-time 20 \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$BASE_URL/health/liveliness" >/dev/null

curl --silent --show-error --fail --max-time 20 \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$BASE_URL/v1/models" |
  node -e '
    let value="";
    process.stdin.on("data",(chunk)=>value+=chunk).on("end",()=>{
      const body=JSON.parse(value);
      if (!body.data.some((model)=>model.id===process.argv[1])) process.exit(1);
    });
  ' "$MODEL"

curl --silent --show-error --fail --max-time 120 \
  "$BASE_URL/v1/messages/count_tokens" \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Count this request\"}]}" |
  node -e '
    let value="";
    process.stdin.on("data",(chunk)=>value+=chunk).on("end",()=>{
      const body=JSON.parse(value);
      if (!(body.input_tokens>0)) process.exit(1);
    });
  '

TEXT_OUTPUT="$(
  "$ROOT_DIR/bin/claude-litellm" \
    --litellm-model "$MODEL" \
    -p \
    --no-session-persistence \
    --prompt-suggestions false \
    "Reply with exactly: ${MARKER_PREFIX}_TEXT_OK"
)"
grep -F "${MARKER_PREFIX}_TEXT_OK" <<<"$TEXT_OUTPUT" >/dev/null

TOOL_OUTPUT="$(
  "$ROOT_DIR/bin/claude-litellm" \
    --litellm-model "$MODEL" \
    -p \
    --no-session-persistence \
    --prompt-suggestions false \
    --allowedTools Read \
    --permission-mode dontAsk \
    "Use the Read tool to read $FIXTURE, then return only the file contents."
)"
grep -F "${MARKER_PREFIX}_READ_TOOL_OK" <<<"$TOOL_OUTPUT" >/dev/null

AFTER_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"
[[ "$BEFORE_SETTINGS_STATE" == "$AFTER_SETTINGS_STATE" ]] || {
  echo "Claude user settings state changed during the LiteLLM test." >&2
  exit 1
}

printf 'PASS model=%s health=true models=true count_tokens=true text=true read_tool=true settings_unchanged=true\n' "$MODEL"
