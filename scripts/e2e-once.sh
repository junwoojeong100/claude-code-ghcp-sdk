#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS_PATH="${HOME}/.claude/settings.json"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"
MARKER="CLAUDE_CODE_GHCP_SDK_E2E_OK"
FIXTURE="$(mktemp "${TMPDIR:-/tmp}/claude-ghcp-fixture.XXXXXX")"

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT

printf '%s\n' "$MARKER" >"$FIXTURE"
BEFORE_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"

TEXT_OUTPUT="$(
  "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --prompt-suggestions false \
    "Reply with exactly: $MARKER"
)"
grep -F "$MARKER" <<<"$TEXT_OUTPUT" >/dev/null

TOOL_OUTPUT="$(
  "$ROOT_DIR/bin/claude-ghcp" \
    --ghcp-model "$MODEL" \
    -p \
    --no-session-persistence \
    --prompt-suggestions false \
    --allowedTools Read \
    --permission-mode dontAsk \
    "Use the Read tool to read $FIXTURE, then return only the file contents."
)"
grep -F "$MARKER" <<<"$TOOL_OUTPUT" >/dev/null

AFTER_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"
[[ "$BEFORE_SETTINGS_STATE" == "$AFTER_SETTINGS_STATE" ]] || {
  echo "Claude user settings state changed during the test." >&2
  exit 1
}

printf 'PASS model=%s settings_unchanged=true\n' "$MODEL"
