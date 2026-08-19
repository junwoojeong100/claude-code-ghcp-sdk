#!/usr/bin/env bash

canonical_path() {
  node -e '
    const fs = require("node:fs");
    console.log(fs.realpathSync(process.argv[1]));
  ' "$1" 2>/dev/null
}

is_repo_claude_wrapper() {
  local candidate="$1"
  local root_dir="$2"
  local candidate_path
  local wrapper
  local wrapper_path

  candidate_path="$(canonical_path "$candidate")" || return 1
  for wrapper in \
    "$root_dir/bin/claude" \
    "$root_dir/bin/claude-ghcp" \
    "$root_dir/bin/claude-litellm" \
    "$root_dir/bin/claude-current"; do
    wrapper_path="$(canonical_path "$wrapper")" || continue
    [[ "$candidate_path" == "$wrapper_path" ]] && return 0
  done
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
    if is_repo_claude_wrapper "$candidate" "$root_dir"; then
      echo "CLAUDE_CODE_BIN must point to the real Claude Code executable, not $candidate." >&2
      return 1
    fi
    printf '%s\n' "$candidate"
    return 0
  fi

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    is_repo_claude_wrapper "$candidate" "$root_dir" && continue
    printf '%s\n' "$candidate"
    return 0
  done < <(type -aP claude 2>/dev/null || true)

  echo "Claude Code executable not found outside $root_dir/bin." >&2
  echo "Install Claude Code or set CLAUDE_CODE_BIN to its executable path." >&2
  return 1
}
