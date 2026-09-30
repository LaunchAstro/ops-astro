#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# T4a: build the fixture snapshot, or clone it into a fresh database.
# Test tooling: the generator lives in tests/fixture/ and is never shipped.
#   bash scripts/local/fixture-snapshot.sh build
#   bash scripts/local/fixture-snapshot.sh clone <database>
# Reads .local/db.env (written by db-up.sh); never starts or changes the server.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ ! -f .local/db.env ]]; then
  echo "fixture-snapshot: no .local/db.env; run the local database first" >&2
  exit 2
fi
set -a
# shellcheck source=/dev/null
. .local/db.env
set +a
exec node tests/fixture/snapshot/snapshot.ts "$@"
