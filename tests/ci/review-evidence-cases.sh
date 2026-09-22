#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Review evidence, bound to a revision.
#
# ADR 0046: Nathan merges only what the machine has already proven, and the
# required checks include a code-review evidence check and a security-review
# check. Round four found neither in CI, so a pull request could carry a
# review of one revision and merge another, or carry no review at all.
#
# The rule this enforces: the pull request body must carry a review
# checkpoint block whose head is the head being merged. Evidence for a
# different revision is not evidence for this one.
#
# Usage: tests/ci/review-evidence-cases.sh [path-to-script]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="${1:-$REPO_ROOT/scripts/review-evidence-check.mjs}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

HEAD=1111111111111111111111111111111111111111
OTHER=2222222222222222222222222222222222222222

# run <label> <expect> <body> <changed files, newline separated>
run_case() {
  local label="$1" expect="$2" body="$3" files="$4" actual
  actual="$(
    PR_BODY="$body" HEAD_SHA="$HEAD" CHANGED_FILES="$files" \
      node "$CHECKER" >/dev/null 2>&1; echo $?
  )"
  if [ "$actual" = "$expect" ]; then pass "$label"; else fail "$label" "expected exit $expect, got $actual"; fi
}

echo "review evidence cases, against $CHECKER"
echo

if [ ! -f "$CHECKER" ]; then
  fail "the checker exists" "no file at $CHECKER; nothing binds a review to a revision in CI"
  echo; echo "review evidence cases: $PASSED passed, $FAILED failed"; exit 1
fi

BARE_BLOCK="Review checkpoint
  branch:      work
  base:        main
  head:        $HEAD
  commits:     1"

GOOD_BLOCK="Review checkpoint
  branch:      work
  base:        main
  head:        $HEAD
  commits:     1

Code review: no findings"

run_case "a checkpoint for this head passes" 0 "$GOOD_BLOCK" "README.md"
run_case "no body at all fails" 1 "" "README.md"
run_case "a body with no checkpoint fails" 1 "I reviewed it, it is fine." "README.md"
run_case "a checkpoint for another revision fails" 1 "Review checkpoint
  head:        $OTHER" "README.md"
run_case "a checkpoint with no head fails" 1 "Review checkpoint
  branch: work" "README.md"

# The sensitive surface. ADR 0046 names auth, tenancy, tool execution,
# egress, custody and the audit chain; a change touching one needs the
# security review attached, bound to the same head.
SEC_BLOCK="$GOOD_BLOCK

Security review: run against $HEAD, no findings."

run_case "a sensitive change without a security review fails" 1 "$GOOD_BLOCK" "packages/core-custody/broker.ts"
run_case "a sensitive change with a security review passes" 0 "$SEC_BLOCK" "packages/core-custody/broker.ts"
run_case "a security review for another revision fails" 1 "$GOOD_BLOCK

Security review: run against $OTHER, no findings." "packages/core-custody/broker.ts"
run_case "the gate itself is a sensitive surface" 1 "$GOOD_BLOCK" "scripts/gate/sweep.py"
run_case "a workflow change is a sensitive surface" 1 "$GOOD_BLOCK" ".github/workflows/ci.yml"
run_case "an ordinary docs change needs no security review" 0 "$GOOD_BLOCK" "docs/plan/README.md"

# Round five, 7 September. The check matched the words "security review" and
# a hash, so a body saying the review was NOT RUN, with the current hash
# beside it, passed. Matching text is not establishing that a review happened.
run_case "a security review marked NOT RUN fails" 1 "$GOOD_BLOCK

Security review: NOT RUN against $HEAD" "packages/core-custody/broker.ts"
run_case "a security review marked skipped fails" 1 "$GOOD_BLOCK

Security review: skipped for $HEAD" "packages/core-custody/broker.ts"
run_case "a security review marked pending fails" 1 "$GOOD_BLOCK

Security review: pending, $HEAD" "packages/core-custody/broker.ts"
run_case "a security review that failed fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, FAILED, two open findings." "packages/core-custody/broker.ts"
run_case "a security review with open findings fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, 2 findings open." "packages/core-custody/broker.ts"
run_case "a security review with no outcome at all fails" 1 "$GOOD_BLOCK

Security review: $HEAD" "packages/core-custody/broker.ts"
run_case "a security review with findings closed passes" 0 "$GOOD_BLOCK

Security review: run against $HEAD, 2 findings, all closed." "packages/core-custody/broker.ts"

# The same for the code review. A checkpoint block proves which revision was
# looked at; it does not say a review happened or what it concluded.
run_case "no code-review outcome fails" 1 "$BARE_BLOCK" "README.md"
run_case "a code review marked not run fails" 1 "$BARE_BLOCK

Code review: not run" "README.md"
run_case "a code review with open findings fails" 1 "$BARE_BLOCK

Code review: 3 findings open" "README.md"
run_case "one good line does not excuse a bad one" 1 "$GOOD_BLOCK

Code review: not run on the second pass" "README.md"
run_case "a code review with no findings passes" 0 "$GOOD_BLOCK

Code review: no findings" "README.md"
run_case "a code review with findings closed passes" 0 "$GOOD_BLOCK

Code review: 3 findings, all closed" "README.md"

# Round seven, 17 September. The template byte for byte, with only the
# checkpoint filled, passed: the parser read the instructional words inside
# the template's own HTML comment as an outcome. The same substring search
# failed a correct body that cited the security procedure by path.
TEMPLATE="$REPO_ROOT/.github/PULL_REQUEST_TEMPLATE.md"
if [ ! -f "$TEMPLATE" ]; then
  fail "the template exists" "no file at $TEMPLATE"
else
  # The template as shipped, with the one block an author always fills.
  FILLED_TEMPLATE="$(awk -v head="$HEAD" '
    /^```$/ { fence = fence + 1; print; if (fence == 1) { print "Review checkpoint"; print "  branch:      work"; print "  base:        main"; print "  head:        " head; print "  commits:     1" } next }
    { print }
  ' "$TEMPLATE")"

  run_case "the untouched template, checkpoint filled, fails" 1 "$FILLED_TEMPLATE" "README.md"
  run_case "the untouched template fails a sensitive change too" 1 "$FILLED_TEMPLATE" "packages/core-custody/broker.ts"

  case "$FILLED_TEMPLATE" in
    *"head:        $HEAD"*) pass "the template fixture really did carry this head" ;;
    *) fail "the template fixture really did carry this head" "the checkpoint was not inserted, so the case above proves nothing" ;;
  esac
fi

run_case "an unreplaced code-review placeholder fails" 1 "$BARE_BLOCK

Code review: REPLACE-WITH-OUTCOME" "README.md"
run_case "an unreplaced security placeholder fails" 1 "$GOOD_BLOCK

Security review: REPLACE-WITH-OUTCOME" "packages/core-custody/broker.ts"
run_case "an empty code-review field fails" 1 "$BARE_BLOCK

Code review:" "README.md"

# Citing the procedure by path is legitimate and must not read as a field.
run_case "a body citing security-review.md by path passes" 0 "$GOOD_BLOCK

Security review: run against $HEAD, no findings. Procedure:
.claude/skills/_shared/security-review.md" "packages/core-custody/broker.ts"
run_case "the procedure path alone is not a security review" 1 "$GOOD_BLOCK

See .claude/skills/_shared/security-review.md for the procedure." \
  "packages/core-custody/broker.ts"
run_case "prose mentioning a code review is not an outcome field" 1 "$BARE_BLOCK

I asked for a code review and one is coming." "README.md"
run_case "a docs change citing security-review.md still passes" 0 "$GOOD_BLOCK

The procedure lives at .claude/skills/_shared/security-review.md." "docs/plan/README.md"

# An outcome inside an HTML comment is instruction to the author, not evidence.
run_case "an outcome hidden in an HTML comment fails" 1 "$BARE_BLOCK

Code review: <!-- no findings -->" "README.md"
run_case "a commented-out checkpoint is not a checkpoint" 1 "<!-- Review checkpoint
  head:        $HEAD -->

Code review: no findings" "README.md"

# Bullets and bold are ordinary Markdown and still read as fields.
run_case "a bulleted code-review field passes" 0 "$BARE_BLOCK

- **Code review**: no findings" "README.md"
run_case "a bulleted code-review field that was not run fails" 1 "$BARE_BLOCK

- **Code review**: not run" "README.md"

echo
echo "review evidence cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
