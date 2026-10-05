#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Audit proof, criterion 7: the split refusal proof test fails in setup in an
# ordinary clone, where the repository root `.git` is a directory.
#
# Run from a checkout of the PR head. It makes a full-history clone (no
# --shared, `.git` a directory, as the `local checks` job's checkout), installs
# with the pinned Corepack pnpm, runs the suite with a private TMPDIR so any
# leftover `split-refusal-*` directory can be counted, then removes the clone.
set -uo pipefail
SRC=$(git rev-parse --show-toplevel) || exit 2
HEAD_SHA=$(git -C "$SRC" rev-parse HEAD)
CUT_PARENT=3a90a92f8f4deab5bf64af2b8b830c911a6fbbb2
WORK=$(mktemp -d "${TMPDIR:-/tmp}/audit-proof-936-1.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
CLONE=$WORK/clone
git clone -q --no-local --no-checkout "$SRC" "$CLONE" || exit 2
cd "$CLONE" || exit 2
git checkout -q --detach "$HEAD_SHA" || exit 2
echo "# clone head: $(git rev-parse HEAD)"
git cat-file -e "$CUT_PARENT^{commit}" && echo "# CUT_PARENT $CUT_PARENT reachable" || { echo "# CUT_PARENT missing"; exit 2; }
echo "# ls -ld .git:"; ls -ld .git
corepack pnpm install --frozen-lockfile >"$WORK/install.log" 2>&1 || { tail -40 "$WORK/install.log"; exit 2; }
echo "# installed with pnpm $(corepack pnpm --version)"
mkdir -p "$WORK/tmp"
TMPDIR=$WORK/tmp corepack pnpm exec vitest run tests/ci/split-refusal-test-catches-a-changed-suite-file.proof.test.ts
rc=$?
echo "# vitest exit $rc"
echo "# split-refusal-* left in TMPDIR after the run:"
ls -1d "$WORK"/tmp/split-refusal-* 2>/dev/null || echo "(none)"
exit $rc
