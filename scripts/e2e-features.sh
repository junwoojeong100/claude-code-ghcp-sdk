#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for attempt in 1 2 3; do
  if "$ROOT_DIR/scripts/e2e-features-once.sh"; then
    exit 0
  fi
  if [[ "$attempt" != "3" ]]; then
    echo "Feature E2E attempt $attempt failed; retrying with fresh fixtures." >&2
  fi
done

echo "Feature E2E failed after 3 attempts." >&2
exit 1
