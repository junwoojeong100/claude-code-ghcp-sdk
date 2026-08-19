#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS_PATH="${HOME}/.claude/settings.json"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"
MARKER="CLAUDE_CODE_GHCP_SDK_E2E_OK"
FIXTURE="$(mktemp "${TMPDIR:-/tmp}/claude-ghcp-fixture.XXXXXX")"

hash_file() {
  node -e '
    const fs=require("node:fs");
    const crypto=require("node:crypto");
    const value=fs.readFileSync(process.argv[1]);
    console.log(crypto.createHash("sha256").update(value).digest("hex"));
  ' "$1"
}

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT

printf '%s\n' "$MARKER" >"$FIXTURE"
BEFORE_HASH="$(hash_file "$SETTINGS_PATH")"

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

AFTER_HASH="$(hash_file "$SETTINGS_PATH")"
[[ "$BEFORE_HASH" == "$AFTER_HASH" ]] || {
  echo "Claude user settings changed during the test." >&2
  exit 1
}

printf 'PASS model=%s settings_unchanged=true\n' "$MODEL"
