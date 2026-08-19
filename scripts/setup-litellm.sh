#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
SOURCE_DIR="$RUNTIME_DIR/litellm-src"
VENV_DIR="$RUNTIME_DIR/litellm-venv"
KEY_FILE="$RUNTIME_DIR/litellm-master-key"
LITELLM_TAG="v1.97.0"
LITELLM_COMMIT="ef84494d52c6708e4e9f4a54ce551a265995ad8f"

for command in git uv node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command not found: $command" >&2
    exit 1
  }
done

mkdir -p "$RUNTIME_DIR"

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --quiet --depth 1 --branch "$LITELLM_TAG" \
    https://github.com/BerriAI/litellm.git "$SOURCE_DIR"
fi

ACTUAL_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[[ "$ACTUAL_COMMIT" == "$LITELLM_COMMIT" ]] || {
  echo "Unexpected LiteLLM commit: $ACTUAL_COMMIT" >&2
  echo "Expected $LITELLM_TAG at $LITELLM_COMMIT" >&2
  exit 1
}

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  uv venv --python 3.13 "$VENV_DIR"
fi

"$VENV_DIR/bin/python" -m ensurepip --upgrade >/dev/null
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check \
  "$SOURCE_DIR[proxy]"
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check \
  "fastapi==0.139.0"

if [[ ! -f "$KEY_FILE" ]]; then
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    fs.writeFileSync(
      process.argv[1],
      `sk-${crypto.randomBytes(32).toString("hex")}\n`,
      { mode: 0o600 },
    );
  ' "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

printf 'LiteLLM %s is ready. Start it with: npm run litellm:start\n' "$LITELLM_TAG"
