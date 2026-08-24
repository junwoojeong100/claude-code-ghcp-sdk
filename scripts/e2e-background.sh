#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"
DAEMON_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-ghcp-daemon.XXXXXX")"
PROJECT="$DAEMON_DIR/project"
RESULT="$PROJECT/background-result.txt"

cleanup() {
  GHCP_DAEMON_DIR="$DAEMON_DIR" \
    "$ROOT_DIR/bin/claude-ghcp-stop" >/dev/null 2>&1 || true
  rm -rf "$DAEMON_DIR"
}
trap cleanup EXIT
mkdir -p "$PROJECT"

BACKGROUND_OUTPUT="$(
  cd "$PROJECT"
  GHCP_DAEMON_DIR="$DAEMON_DIR" \
    "$ROOT_DIR/bin/claude-ghcp" \
      --ghcp-model "$MODEL" \
      --background \
      --allowedTools Write \
      --permission-mode acceptEdits \
      "Use Write to create $RESULT with exactly BACKGROUND_E2E_OK"
)"
[[ -n "$BACKGROUND_OUTPUT" ]]

STATUS="$(
  GHCP_DAEMON_DIR="$DAEMON_DIR" \
    "$ROOT_DIR/bin/claude-ghcp-status"
)"
node -e '
  const status = JSON.parse(process.argv[1]);
  if (!status.running || !status.pid || !status.port) process.exit(1);
' "$STATUS"

AGENT_VIEW_OK=0
BACKGROUND_RESULT_OK=0
for _ in {1..120}; do
  AGENTS="$(
    GHCP_DAEMON_DIR="$DAEMON_DIR" \
      "$ROOT_DIR/bin/claude-ghcp" \
        agents --json --all --cwd "$PROJECT"
  )"
  if node -e '
    const value = JSON.parse(process.argv[1]);
    const sessions = Array.isArray(value) ? value : value.sessions;
    if (!Array.isArray(sessions) || sessions.length < 1) process.exit(1);
  ' "$AGENTS"; then
    AGENT_VIEW_OK=1
  fi
  if [[ -f "$RESULT" ]] && grep -F "BACKGROUND_E2E_OK" "$RESULT" >/dev/null; then
    BACKGROUND_RESULT_OK=1
  fi
  if [[ "$AGENT_VIEW_OK" == "1" && "$BACKGROUND_RESULT_OK" == "1" ]]; then
    break
  fi
  sleep 1
done
[[ "$AGENT_VIEW_OK" == "1" ]]
[[ "$BACKGROUND_RESULT_OK" == "1" ]]

GHCP_DAEMON_DIR="$DAEMON_DIR" \
  "$ROOT_DIR/bin/claude-ghcp-stop" >/dev/null
STOPPED="$(
  GHCP_DAEMON_DIR="$DAEMON_DIR" \
    "$ROOT_DIR/bin/claude-ghcp-status"
)"
node -e '
  const status = JSON.parse(process.argv[1]);
  if (status.running) process.exit(1);
' "$STOPPED"

[[ ! -e "$DAEMON_DIR/bridge.json" ]]
[[ ! -e "$DAEMON_DIR/bridge.log" ]]

printf 'PASS model=%s background=true background_result=true agent_view=true bridge_daemon_cleanup=true claude_daemon_persistent=true\n' "$MODEL"
