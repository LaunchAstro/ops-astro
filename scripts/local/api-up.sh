#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Start the slice's API in the foreground on 127.0.0.1:${API_PORT:-8790}.
#
# It checks the two things whose absence produces a confusing failure later —
# the local env files — and then hands over to Node's own type stripping, which
# is why there is no build step between the TypeScript on disk and the process
# serving requests.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${API_PORT:-8790}"

for file in db.env auth.env; do
  if [ ! -f "${ROOT}/.local/${file}" ]; then
    echo "api-up: ${ROOT}/.local/${file} is missing." >&2
    echo "api-up: run scripts/local/db-up.sh and scripts/local/auth-up.sh first." >&2
    exit 1
  fi
done

if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "api-up: something is already answering on 127.0.0.1:${PORT}"
  curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo
  exit 0
fi

echo "api-up: starting the API on http://127.0.0.1:${PORT}"
exec node "${ROOT}/apps/api/server.ts"
