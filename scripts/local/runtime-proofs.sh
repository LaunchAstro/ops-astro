#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# T3d2: the two runtime proofs as one named run, at whatever head is checked out.
#
#   pnpm verify:runtime-proofs [--name NAME] [--port PORT] [--api-port PORT] [--evidence FILE]
#
# F1 (`apply_after_api_stops`) and F2 (`crash_between_apply_and_settle`) in
# tests/acceptance/runtime-proofs.test.tsx, and T3e1's drops from real
# processes in tests/acceptance/drop-proofs.test.ts: real API and worker
# processes, each killed with SIGKILL by its own pid, on a disposable two-business
# Postgres of the run's own, never the shared one (T3.md, RUN-07).
# `restart-proof.sh` creates, migrates and removes that container and kills
# whatever the run left running; this names the suite, a container and ports
# of its own, and asks for the proofs. Later arguments win.

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
L5_RUNTIME_PROOFS=1 exec bash "$here/restart-proof.sh" \
  --name ops-astro-runtime-proofs-pg --port 54396 --api-port 8796 \
  --suite tests/acceptance/runtime-proofs.test.tsx --suite tests/acceptance/drop-proofs.test.ts "$@"
