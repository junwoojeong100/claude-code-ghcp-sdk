#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"
SETTINGS_PATH="${HOME}/.claude/settings.json"
ROOT_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-ghcp-session.XXXXXX")"

cleanup() {
  rm -rf "$ROOT_CONFIG_DIR"
}
trap cleanup EXIT

run_scenario() {
  local config_dir="$1"
  local session_id token first resumed forked
  session_id="$(node -e 'console.log(require("node:crypto").randomUUID())')"
  token="SESSION_E2E_$(node -e 'console.log(require("node:crypto").randomBytes(8).toString("hex"))')"

  first="$(
    CLAUDE_CONFIG_DIR="$config_dir" \
      "$ROOT_DIR/bin/claude-ghcp" \
        --ghcp-model "$MODEL" \
        -p \
        --session-id "$session_id" \
        "Remember the exact token $token for this session, then reply exactly STORED."
  )" || return 1
  grep -F "STORED" <<<"$first" >/dev/null || return 1

  resumed="$(
    CLAUDE_CONFIG_DIR="$config_dir" \
      "$ROOT_DIR/bin/claude-ghcp" \
        --ghcp-model "$MODEL" \
        -p \
        --resume "$session_id" \
        'Return only the exact token I asked you to remember.'
  )" || return 1
  grep -F "$token" <<<"$resumed" >/dev/null || return 1

  forked="$(
    CLAUDE_CONFIG_DIR="$config_dir" \
      "$ROOT_DIR/bin/claude-ghcp" \
        --ghcp-model "$MODEL" \
        -p \
        --resume "$session_id" \
        --fork-session \
        'Return the remembered token followed by FORK_E2E_OK.'
  )" || return 1
  grep -F "$token" <<<"$forked" >/dev/null || return 1
  grep -F "FORK_E2E_OK" <<<"$forked" >/dev/null || return 1
}

BEFORE_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"

SESSION_OK=0
for attempt in 1 2 3; do
  CONFIG_DIR="$ROOT_CONFIG_DIR/attempt-$attempt"
  mkdir -p "$CONFIG_DIR"
  if run_scenario "$CONFIG_DIR"; then
    SESSION_OK=1
    break
  fi
done
[[ "$SESSION_OK" == "1" ]]

AFTER_SETTINGS_STATE="$(
  node "$ROOT_DIR/src/settings-file-state.mjs" "$SETTINGS_PATH"
)"
[[ "$BEFORE_SETTINGS_STATE" == "$AFTER_SETTINGS_STATE" ]] || {
  echo "Claude user settings state changed during session E2E." >&2
  exit 1
}

printf 'PASS model=%s resume=true fork=true settings_unchanged=true\n' "$MODEL"

