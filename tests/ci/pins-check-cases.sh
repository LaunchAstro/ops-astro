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
# Sol's recheck of 356dbe5: YAML allows space before the colon, and the check
# needed the colon straight after the key, so these read as no key at all.
run_case "Sol's container : node:20 fails" 1 "jobs:
  a:
    container : node:20
$STEPS"
run_case "Sol's image : \${{ vars.DB_IMAGE }} fails" 1 "jobs:
  db:
    services:
      postgres:
        image : \${{ vars.DB_IMAGE }}
$STEPS"
run_case "a quoted image key on a tag fails" 1 "jobs:
  db:
    services:
      postgres:
        'image': postgres:18-alpine
$STEPS"
run_case "a double-quoted uses key on a tag fails" 1 "jobs:
  a:
    steps:
      - \"uses\": actions/checkout@v4"
run_case "uses : on a tag fails" 1 "jobs:
  a:
    steps:
      - uses : actions/checkout@v4"
run_case "a spaced container mapping with a digested image passes" 0 "jobs:
  a:
    container :
      image : postgres@sha256:$DIGEST
$STEPS"

# Security rerun at 356dbe5, N2: a `docker://` step was skipped outright, so a
# step image on a movable tag passed.
run_case "a docker:// step on a tag fails" 1 "jobs:
  a:
    steps:
      - uses: docker://node:20"
run_case "a docker:// step digested but not recorded fails" 1 "jobs:
  a:
    steps:
      - uses: docker://node@sha256:3333333333333333333333333333333333333333333333333333333333333333"
run_case "a docker:// step digested and recorded passes" 0 "jobs:
  a:
    steps:
      - uses: docker://postgres@sha256:$DIGEST
      - uses: $ACTION"
# Security rerun at 974d039, R1: a value may continue on the next line, and
# 974d039 stopped reading `uses:` written that way.
run_case "a tagged uses: value on the next line fails" 1 "jobs:
  a:
    steps:
      - name: x
        uses:
          actions/checkout@v4"
run_case "a pinned uses: value on the next line passes" 0 "jobs:
  a:
    steps:
      - uses:
          $ACTION"
# R2: a key inside a flow collection, or an explicit `? ` key, is refused
# outright; the check reads block style only.
run_case "R2 - { uses: actions/checkout@v4 } fails" 1 "jobs:
  a:
    steps:
      - { uses: actions/checkout@v4 }"
run_case "R2 - {name: x, uses: \"docker://node:20\"} fails" 1 "jobs:
  a:
    steps:
      - {name: x, uses: \"docker://node:20\"}"
run_case "R2 db: { image: \"postgres:18\" } fails" 1 "jobs:
  a:
    services:
      db: { image: \"postgres:18\" }
$STEPS"
run_case "R2 - ? uses / : actions/checkout@v4 fails" 1 "jobs:
  a:
    steps:
      - ? uses
        : actions/checkout@v4"
run_case "a pinned uses in a flow sequence still fails" 1 "jobs:
  a:
    steps: [ uses: $ACTION ]"
# Sol's recheck of d1a2cef: a key straight after the bracket, and a `#` inside
# a scalar before the key, hid the key. A `#` is a comment only outside quotes
# and after a space, and a comment line is never scanned.
for l in '- {uses: actions/checkout@v4}' '- {name: "#", uses: actions/checkout@v4}' \
  "- {name: '#', uses: actions/checkout@v4}" '- {name: step#1, uses: actions/checkout@v4}'; do
  run_case "flow step $l fails" 1 "jobs:
  a:
    steps:
      $l"
done
# T1 at 3f2b259 (Sol rated it P2): YAML escapes a single quote by doubling it,
# and reading `''` as a close and a reopen let a later `#` read as a comment.
for l in "- { name: 'it''s # x', uses: actions/checkout@v4 }" \
  "- {name: 'can''t # hide this', uses: actions/checkout@v4}"; do
  run_case "flow step $l fails" 1 "jobs:
  a:
    steps:
      $l"
done
run_case "db: {name: 'can''t # x', image: node:20} fails" 1 "jobs:
  a:
    services:
      db: {name: 'can''t # x', image: node:20}
$STEPS"
run_case "a pinned image after a doubled quote in a flow scalar still fails as flow" 1 "jobs:
  a:
    services:
      db: {name: 'it''s', image: postgres@sha256:$DIGEST}
$STEPS"
run_case "a doubled quote in a block run value passes" 0 "jobs:
  a:
    steps:
      - run: echo 'it''s # { uses: x }'
      - uses: $ACTION"
run_case "db: {image: node:20} fails" 1 "jobs:
  a:
    services:
      db: {image: node:20}
$STEPS"
run_case "a commented-out flow step passes" 0 "jobs:
  a:
    steps:
      # - { uses: actions/checkout@v4 }
      - uses: $ACTION"
run_case "a flow key inside a quoted run value passes" 0 "jobs:
  a:
    steps:
      - run: echo '{ uses: x }' \"[image: y]\"
      - uses: $ACTION"
run_case "a pinned workflow in block style still passes" 0 "jobs:
  a:
    container:
      image: postgres@sha256:$DIGEST
    services:
      db:
        image: postgres@sha256:$DIGEST # postgres:18-alpine
    steps:
      - name: check out
        uses: $ACTION # v7
      - uses: docker://postgres@sha256:$DIGEST
      - run: echo '{ not a key }'"
# Security rerun at d1a2cef, S1: lines were split on LF alone, so a CRLF or
# CR-only workflow kept a `\r` on every line, no key matched, and the check
# said green. A workflow saved on Windows is committed as it is.
crlf() { printf '%s\n' "$1" | awk '{ printf "%s\r\n", $0 }'; }
cr() { printf '%s\n' "$1" | tr '\n' '\r'; }
TAGGED="jobs:
  a:
    steps:
      - uses: actions/checkout@v4"
run_case "a CRLF workflow with a tagged uses fails" 1 "$(crlf "$TAGGED")"
run_case "a CR-only workflow with a tagged uses fails" 1 "$(cr "$TAGGED")"
run_case "a CRLF container: node:20 fails" 1 "$(crlf "jobs:
  a:
    container: node:20
$STEPS")"
run_case "a CRLF workflow, fully pinned and recorded, passes" 0 "$(crlf "jobs:
  a:
    container:
      image: postgres@sha256:$DIGEST
    steps:
      - uses: $ACTION # v7
      - uses: docker://postgres@sha256:$DIGEST")"
run_case "an image: with no value on its line fails" 1 "jobs:
  db:
    services:
      postgres:
        image:
$STEPS"

echo
echo "pins-check cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
