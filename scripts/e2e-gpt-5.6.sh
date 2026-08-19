#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for model in gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna; do
  GHCP_E2E_MODEL="$model" "$ROOT_DIR/scripts/e2e.sh"
done
