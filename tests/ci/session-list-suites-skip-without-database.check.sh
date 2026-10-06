#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Audit proof, correctness: the database-free local checks skip or exclude the
# two new session-list ending suites and exit successfully.
# Sol finding B2-FIX1.1 on PR #938. With DATABASE_URL and DATABASE_ADMIN_URL
# absent, as in CI's database-free local-checks step, selecting the two suites
# must not fail. A non-zero exit here means the finding stands.
set -uo pipefail
env -u DATABASE_URL -u DATABASE_ADMIN_URL corepack pnpm exec vitest run \
  tests/api/end-others-leaves-session-list-in-every-business.test.ts \
  tests/identity/session-list-subject-wide-ending.test.ts \
  --passWithNoTests
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "AUDIT-PROOF-938-1: FAIL (vitest exit $rc without a database)" >&2
  exit 1
fi
echo "AUDIT-PROOF-938-1: PASS"
