#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"

OUTPUT="$(
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly INPUT_STREAM_E2E_OK"}]}}' |
    "$ROOT_DIR/bin/claude-ghcp" \
      --ghcp-model "$MODEL" \
      -p \
      --no-session-persistence \
      --input-format stream-json \
      --output-format stream-json \
      --verbose \
      --replay-user-messages
)"

node -e '
  const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const replay = events.some((event) => event.type === "user" && event.isReplay);
  const result = events.findLast((event) => event.type === "result");
  if (!replay || !result?.result?.includes("INPUT_STREAM_E2E_OK")) process.exit(1);
' "$OUTPUT"

printf 'PASS model=%s input_stream=true output_stream=true replay_user=true\n' "$MODEL"

