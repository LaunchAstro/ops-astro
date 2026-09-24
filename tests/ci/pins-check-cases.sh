#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# pins-check against throwaway trees.
#
# The script reads the workflows and the pin record beside it, so each case
# copies it into a scratch tree holding one workflow and one record.
#
# The security review of d77b375, finding 4, 24 September: rule 2 read only
# `image:`, so `container: node:20` passed, and it skipped any image written
# as an expression, so `image: ${{ vars.DB_IMAGE }}` passed too. Both run a
# container nobody pinned.
#
# Usage: tests/ci/pins-check-cases.sh [path-to-script]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="${1:-$REPO_ROOT/scripts/pins-check.mjs}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ACTION=actions/checkout@1111111111111111111111111111111111111111
DIGEST=2222222222222222222222222222222222222222222222222222222222222222
RECORD="actions/checkout 1111111111111111111111111111111111111111
postgres $DIGEST"

# run <label> <expect> <workflow text> [record text]
run_case() {
  local label="$1" expect="$2" workflow="$3" record="${4-$RECORD}" tree actual
  tree="$(mktemp -d "$SCRATCH/case.XXXXXX")"
  mkdir -p "$tree/scripts" "$tree/.github/workflows" "$tree/docs"
  cp "$CHECKER" "$tree/scripts/pins-check.mjs"
  printf '%s\n' "$workflow" > "$tree/.github/workflows/ci.yml"
  printf '%s\n' "$record" > "$tree/docs/supply-chain-pins.md"
  actual="$(node "$tree/scripts/pins-check.mjs" >/dev/null 2>&1; echo $?)"
  if [ "$actual" = "$expect" ]; then pass "$label"; else fail "$label" "expected exit $expect, got $actual"; fi
}

echo "pins-check cases, against $CHECKER"
echo

if [ ! -f "$CHECKER" ]; then
  fail "the checker exists" "no file at $CHECKER"
  echo; echo "pins-check cases: $PASSED passed, $FAILED failed"; exit 1
fi

STEPS="    steps:
      - uses: $ACTION"

run_case "a pinned, recorded action and service image pass" 0 "jobs:
  db:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres@sha256:$DIGEST # postgres:18-alpine
$STEPS"
run_case "an action on a tag fails" 1 "jobs:
  a:
    steps:
      - uses: actions/checkout@v4"
run_case "an action pinned but not recorded fails" 1 "$STEPS" "nothing recorded"
run_case "a service image on a tag fails" 1 "jobs:
  db:
    services:
      postgres:
        image: postgres:18-alpine
$STEPS"
run_case "a digested image not recorded fails" 1 "jobs:
  db:
    services:
      postgres:
        image: postgres@sha256:$DIGEST
$STEPS" "actions/checkout 1111111111111111111111111111111111111111"

# Finding 4, the string form: `container:` names the job's image directly.
run_case "the reviewer's container: node:20 fails" 1 "jobs:
  a:
    container: node:20
$STEPS"
run_case "a container on a tag with a comment fails" 1 "jobs:
  a:
    container: node:20 # the build image
$STEPS"
run_case "a quoted container tag fails" 1 "jobs:
  a:
    container: 'node:20'
$STEPS"
run_case "a digested, recorded container string passes" 0 "jobs:
  a:
    container: postgres@sha256:$DIGEST
$STEPS"
run_case "a container mapping with a tagged image fails" 1 "jobs:
  a:
    container:
      image: node:20
      options: --cpus 1
$STEPS"
run_case "a container mapping with a digested image passes" 0 "jobs:
  a:
    container: # the job image
      image: postgres@sha256:$DIGEST
$STEPS"
run_case "a container in flow style with a tag fails" 1 "jobs:
  a:
    container: { image: node:20 }
$STEPS"
run_case "a bare container: followed by a plain scalar fails" 1 "jobs:
  a:
    container:
      node:20
$STEPS"

# Finding 4, the expression form: the image is chosen at run time, so no digest
# in the workflow pins it.
run_case "the reviewer's image: \${{ vars.DB_IMAGE }} fails" 1 "jobs:
  db:
    services:
      postgres:
        image: \${{ vars.DB_IMAGE }}
$STEPS"
run_case "a container expression fails" 1 "jobs:
  a:
    container: \${{ matrix.image }}
$STEPS"
run_case "an image: with no value on its line fails" 1 "jobs:
  db:
    services:
      postgres:
        image:
$STEPS"

echo
echo "pins-check cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
