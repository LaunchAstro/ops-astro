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

Security review: run against $HEAD, no findings.
Procedure: .claude/skills/_shared/security-review.md" "packages/core-custody/broker.ts"
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

# Round eight, 23 September. Four holdings, each with the pair that proves it.

# 1. The outcome words were matched as bare substrings, so `not approved` read
# as an approval and a rejected review received green evidence.
run_case "a code review that is not approved fails" 1 "$BARE_BLOCK

Code review: not approved" "README.md"
run_case 'free-text "approved, no findings" is outside the grammar and fails' 1 "$BARE_BLOCK

Code review: approved, no findings" "README.md"

# 2. Only the first security-review revision was read, so a second line naming
# an older revision was invisible. Evidence for the base is not evidence here.
run_case "a second security review for an older revision fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, no findings.

Security review: run against $OTHER, no findings." "packages/core-custody/broker.ts"
run_case "two security reviews, both for this head, pass" 0 "$GOOD_BLOCK

Security review: run against $HEAD, no findings.

Security review: run against $HEAD, 1 finding, all closed." "packages/core-custody/broker.ts"

# 3. The security placeholder was read only where the surface required a
# review, so an untouched line passed on an ordinary change. The template asks
# for both lines to be replaced.
run_case "an unreplaced security placeholder fails a non-sensitive change too" 1 "$GOOD_BLOCK

Security review: REPLACE-WITH-OUTCOME" "README.md"
run_case "a non-sensitive change saying no review was called for passes" 0 "$GOOD_BLOCK

Security review: not required: no sensitive paths changed" "README.md"

# 4. The template advertises `the review found nothing` as passing wording and
# the parser refused it, so the two disagreed about a valid outcome.
run_case "the template's advertised passing wording passes" 0 "$BARE_BLOCK

Code review: the review found nothing" "README.md"
run_case "the same wording does not rescue a review still pending" 1 "$BARE_BLOCK

Code review: the review is still pending, so it found nothing to report yet" "README.md"

# Round nine, 23 September. The negation was narrower than the grammar it
# reversed, so a rejection with one word of English inside it read as green,
# and a disposition closing some of the findings read as closing all of them.

run_case "a code review that is not all closed fails" 1 "$BARE_BLOCK

Code review: not all findings are closed" "README.md"
run_case 'free-text "all findings are closed" is outside the grammar and fails' 1 "$BARE_BLOCK

Code review: all findings are closed" "README.md"

run_case "a code review that is not fully approved fails" 1 "$BARE_BLOCK

Code review: not fully approved" "README.md"
run_case 'free-text "fully approved" is outside the grammar and fails' 1 "$BARE_BLOCK

Code review: fully approved" "README.md"

run_case "a code review closing some of its findings fails" 1 "$BARE_BLOCK

Code review: 2 findings, 1 closed" "README.md"
run_case "a code review closing every finding it counted passes" 0 "$BARE_BLOCK

Code review: 2 findings, 2 closed" "README.md"

run_case "a security review closing one of three findings fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, 1 of 3 findings closed" "packages/core-custody/broker.ts"
run_case 'free-text "3 of 3 findings closed" is outside the grammar and fails' 1 "$GOOD_BLOCK

Security review: run against $HEAD, 3 of 3 findings closed" "packages/core-custody/broker.ts"

# Round ten, 24 September. Both round-nine fixes were bounded, and the bounds
# were the way through: four words between a negator and the approval, or a
# full stop between the count raised and the count closed. The inputs are the
# review's own, with this head's checkpoint and a valid sensitive security
# review beside them.
SEC_ONLY="Security review: run against $HEAD, no findings."

run_case "a negator four words from the approval fails" 1 "$BARE_BLOCK

Code review: not in any way fully approved

$SEC_ONLY" "packages/core-custody/broker.ts"
run_case "a negator in an earlier clause fails" 1 "$BARE_BLOCK

Code review: not, in any way, approved

$SEC_ONLY" "packages/core-custody/broker.ts"
run_case 'free-text "approved in every way" is outside the grammar and fails' 1 "$BARE_BLOCK

Code review: approved in every way

$SEC_ONLY" "packages/core-custody/broker.ts"

run_case "a partial closure across a full stop fails" 1 "$BARE_BLOCK

Code review: 2 findings. 1 closed

$SEC_ONLY" "packages/core-custody/broker.ts"
run_case "a partial security closure across a full stop fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, 3 findings. 1 of them closed" "packages/core-custody/broker.ts"
run_case 'free-text "2 findings. 2 closed" is outside the grammar and fails' 1 "$BARE_BLOCK

Code review: 2 findings. 2 closed

$SEC_ONLY" "packages/core-custody/broker.ts"

# Round eleven, 24 September. Counting read only `findings` and `closed`, so
# the same partial disposition in other words passed, and `approved` anywhere
# on the line approved a review that made its approval conditional.
for line in "approved with 2 findings; 1 resolved" "approved with 2 issues; 1 closed" \
  "approved with some issues"; do
  run_case "a code review line '$line' fails" 1 "$BARE_BLOCK

Code review: $line

$SEC_ONLY" "packages/core-custody/broker.ts"
  run_case "a security review line '$line' fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, $line" "packages/core-custody/broker.ts"
done
for line in "approved subject to resolving 1 finding" "approved pending the fix" \
  "approved once the blocker is fixed" "approved after the concern is addressed" \
  "approved if the problem is resolved" "approved provided the issue is closed"; do
  run_case "a conditional approval '$line' fails" 1 "$BARE_BLOCK

Code review: $line

$SEC_ONLY" "packages/core-custody/broker.ts"
done
run_case 'free-text "approved with 2 issues; 2 resolved" is outside the grammar and fails' 1 "$BARE_BLOCK

Code review: approved with 2 issues; 2 resolved

$SEC_ONLY" "packages/core-custody/broker.ts"
run_case 'free-text "2 concerns, both addressed" is outside the grammar and fails' 1 "$GOOD_BLOCK

Security review: run against $HEAD, 2 concerns, both addressed" "packages/core-custody/broker.ts"

# Round twelve, 24 September. Three rounds of phrase rules each moved the
# hole, so the outcome is no longer read as free text: the whole text after
# the field name must be one form of a closed grammar (CONTRIBUTING.md).
# Every one of these read as positive to some round of phrase rules.
for line in "changes requested; all tests passed" "can't approve; all tests passed" \
  "no findings, but changes requested" "2 findings; all addressed except one" \
  "approved; 2 findings, 2 resolved; 1 issue remains" "approved" \
  "approved with 2 findings; 2 resolved" "no findings after recheck" \
  "3 findings, 2 closed" "1 findings, all closed" "2 finding, 2 closed" "0 findings, all closed"; do
  run_case "code-review outcome '$line' is outside the grammar and fails" 1 "$BARE_BLOCK

Code review: $line

$SEC_ONLY" "packages/core-custody/broker.ts"
  run_case "security-review outcome 'run against <head>, $line' fails" 1 "$GOOD_BLOCK

Security review: run against $HEAD, $line" "packages/core-custody/broker.ts"
done
for line in "no findings" "the review found nothing" "every finding it raised is closed" \
  "1 finding, all closed" "1 finding, 1 closed" "3 findings, all closed" "3 findings, 3 closed" \
  "No findings."; do
  run_case "code-review form '$line' passes" 0 "$BARE_BLOCK

Code review: $line

$SEC_ONLY" "packages/core-custody/broker.ts"
done
for line in "no findings" "1 finding, all closed" "1 finding, 1 closed" "2 findings, all closed" \
  "2 findings, 2 closed"; do
  run_case "security-review form 'run against <head>, $line' passes" 0 "$GOOD_BLOCK

Security review: run against $HEAD, $line." "packages/core-custody/broker.ts"
done
# Round thirteen, 24 September. A free reason after `not required:` read
# anything as an answer, `pending` and a rejected review included, so the
# non-sensitive form is now one fixed text.
for line in "not required: pending" "not required: review was rejected; 2 findings, 1 closed" \
  "not required: this change touches docs only"; do
  run_case "security review '$line' fails a non-sensitive change" 1 "$GOOD_BLOCK

Security review: $line" "README.md"
done
run_case "the fixed form, any case, trailing stop, passes a non-sensitive change" 0 "$GOOD_BLOCK

Security review: Not required: No sensitive paths changed.
The diff is documentation and test fixtures only." "README.md"
run_case "the fixed form fails a sensitive change" 1 "$GOOD_BLOCK

Security review: not required: no sensitive paths changed" "packages/core-custody/broker.ts"
run_case "security review 'not required' with no reason fails" 1 "$GOOD_BLOCK

Security review: not required:" "README.md"
run_case "security review 'not required' fails a sensitive change" 1 "$GOOD_BLOCK

Security review: not required: the reviewer judged it low risk" "packages/core-custody/broker.ts"
run_case "an explanation on the following line is not read" 0 "$BARE_BLOCK

Code review: 2 findings, all closed
Both were naming nits in the tests; neither needed a second pass.

$SEC_ONLY" "packages/core-custody/broker.ts"

# The template's other advertised wording, read off the file itself so the two
# cannot drift apart again without this case saying so.
if [ -f "$TEMPLATE" ]; then
  case "$(cat "$TEMPLATE")" in
    *"every finding it raised is closed"*"<N> findings, <N> closed"*"not required: no sensitive paths changed"*)
      pass "the template still advertises the wording these cases assert" ;;
    *) fail "the template still advertises the wording these cases assert" \
      "the template's passing wording moved; the cases above now prove nothing about it" ;;
  esac
  run_case "the template's second advertised wording passes" 0 "$BARE_BLOCK

Code review: every finding it raised is closed" "README.md"
fi

echo
echo "review evidence cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
