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

WORKTREE_OK=0
for attempt in 1 2 3; do
  OUTPUT="$(
    cd "$REPOSITORY"
    "$ROOT_DIR/bin/claude-ghcp" \
      --ghcp-model "$MODEL" \
      -p \
      --worktree "ghcp-e2e-$attempt" \
      --allowedTools Bash \
      --permission-mode dontAsk \
      'Use Bash to run git rev-parse --is-inside-work-tree, then return exactly WORKTREE_E2E_OK.'
  )" || continue
  if grep -F "WORKTREE_E2E_OK" <<<"$OUTPUT" >/dev/null; then
    WORKTREE_OK=1
    break
  fi
done
[[ "$WORKTREE_OK" == "1" ]]
[[ "$(git -C "$REPOSITORY" status --short)" == "" ]]

printf 'PASS model=%s worktree=true source_clean=true\n' "$MODEL"
