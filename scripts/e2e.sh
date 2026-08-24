#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for attempt in 1 2 3; do
  if "$ROOT_DIR/scripts/e2e-once.sh"; then
    exit 0
  fi
  if [[ "$attempt" != "3" ]]; then
    echo "Base E2E attempt $attempt failed; retrying with a fresh fixture." >&2
    sleep $((attempt * 3))
  fi
done

echo "Base E2E failed after 3 attempts." >&2
exit 1
