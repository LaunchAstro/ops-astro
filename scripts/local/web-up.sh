#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Start the web application against the local API.
#
# It starts a dev server and nothing else: no database, no API, no seed. Those
# are owned by the other two lanes and starting them from here would mean two
# scripts believe they own the same container.
#
# The port is fixed rather than negotiated. A dev server that silently moves to
# the next free port produces evidence with the wrong address in it, so
# `strictPort` is set in the Vite config and this script fails loudly instead.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"

export WEB_PORT="${WEB_PORT:-5190}"
export API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:8790}"
export VITE_GOTRUE_URL="${GOTRUE_URL:-http://127.0.0.1:54391}"

echo "web      http://127.0.0.1:${WEB_PORT}"
echo "api      ${API_ORIGIN} (proxied at /api)"
echo "identity ${VITE_GOTRUE_URL}"

exec pnpm --filter @launchastro/web exec vite --host 127.0.0.1 --port "${WEB_PORT}"
