#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${GHCP_E2E_MODEL:-claude-haiku-4.5}"
REPOSITORY="$(mktemp -d "${TMPDIR:-/tmp}/claude-ghcp-worktree.XXXXXX")"

cleanup() {
  rm -rf "$REPOSITORY"
}
trap cleanup EXIT

git -C "$REPOSITORY" init --quiet
git -C "$REPOSITORY" config user.email "e2e@example.invalid"
git -C "$REPOSITORY" config user.name "GHCP E2E"
printf '%s\n' "worktree fixture" >"$REPOSITORY/README.md"
git -C "$REPOSITORY" add README.md
git -C "$REPOSITORY" commit --quiet -m "test fixture"

PROOF="worktree-proof-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))').txt"
WORKTREE_OK=0
for attempt in 1 2 3; do
  OUTPUT="$(
    cd "$REPOSITORY"
    "$ROOT_DIR/bin/claude-ghcp" \
      --ghcp-model "$MODEL" \
      -p \
      --worktree "ghcp-e2e-$attempt" \
      --output-format stream-json \
      --verbose \
      --allowedTools Bash \
      --permission-mode dontAsk \
      "Use Bash to run pwd, printf WORKTREE_SIDE_EFFECT > $PROOF, and cat $PROOF, then return exactly WORKTREE_E2E_OK."
  )" || continue
  if node -e '
    const events = process.argv[1].split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const proof = process.argv[2];
    const bashCall = events
      .filter((event) => event.type === "assistant")
      .flatMap((event) => event.message?.content || [])
      .find((block) =>
        block.type === "tool_use" &&
        block.name === "Bash" &&
        String(block.input?.command || "").includes(proof)
      );
    const result = events.findLast((event) => event.type === "result");
    const toolResult = events.some((event) =>
      event.type === "user" &&
      JSON.stringify(event.message?.content || "").includes("WORKTREE_SIDE_EFFECT")
    );
    if (
      !bashCall ||
      !toolResult ||
      !result?.result?.includes("WORKTREE_E2E_OK")
    ) process.exit(1);
  ' "$OUTPUT" "$PROOF"; then
    WORKTREE_OK=1
    break
  fi
done
[[ "$WORKTREE_OK" == "1" ]]
[[ ! -e "$REPOSITORY/$PROOF" ]]
[[ "$(git -C "$REPOSITORY" status --short)" == "" ]]

printf 'PASS model=%s worktree=true source_clean=true\n' "$MODEL"
