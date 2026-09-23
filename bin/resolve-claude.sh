#!/usr/bin/env bash

canonical_path() {
  node -e '
    const fs = require("node:fs");
    console.log(fs.realpathSync(process.argv[1]));
  ' "$1" 2>/dev/null
}

# A launcher from ANY checkout of this repo, not just this one: a worktree or a
# second clone puts its own bin/ on PATH too, and exec'ing another checkout's
# launcher runs that checkout's bridge instead of the real Claude Code. Every
# launcher sits next to this file, so that is what identifies one.
is_repo_claude_wrapper() {
  local candidate="$1"
  local candidate_path

  candidate_path="$(canonical_path "$candidate")" || return 1
  case "${candidate_path##*/}" in
    claude | claude-ghcp | claude-litellm | claude-current)
      [[ -f "${candidate_path%/*}/resolve-claude.sh" ]] && return 0
      ;;
  esac
  return 1
}

resolve_claude_code_bin() {
  local root_dir="$1"
  local explicit="${CLAUDE_CODE_BIN:-}"
  local candidate

  if [[ -n "$explicit" ]]; then
    if [[ "$explicit" == */* ]]; then
      candidate="$explicit"
    else
      candidate="$(type -P "$explicit" 2>/dev/null || true)"
    fi

    if [[ -z "$candidate" || ! -x "$candidate" ]]; then
      echo "CLAUDE_CODE_BIN is not executable: $explicit" >&2
      return 1
    fi
    if is_repo_claude_wrapper "$candidate"; then
      echo "CLAUDE_CODE_BIN must point to the real Claude Code executable, not $candidate." >&2
      return 1
    fi
    printf '%s\n' "$candidate"
    return 0
  fi

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    is_repo_claude_wrapper "$candidate" && continue
    printf '%s\n' "$candidate"
    return 0
  done < <(type -aP claude 2>/dev/null || true)

  echo "Claude Code executable not found outside this repo's launchers ($root_dir/bin)." >&2
  echo "Install Claude Code or set CLAUDE_CODE_BIN to its executable path." >&2
  return 1
}
