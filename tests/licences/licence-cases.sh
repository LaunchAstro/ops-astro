#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The dependency licence checker, tested against reports it must refuse.
#
# Finding 21 of the sweep: the checker validated JSON syntax and nothing else.
# An empty report, an empty licence expression, a wrong package shape and a
# report describing zero packages all exited 0. Worse, it treated OSI approval
# as the question, when the question is whether a licence can be distributed
# inside an AGPL-3.0-only work.
#
# Every case here is a report the checker must refuse, plus one it must
# accept. They are the negative tests the finding asked to keep.
#
# Usage: tests/licences/licence-cases.sh [path-to-checker]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="${1:-$REPO_ROOT/scripts/licences/check.mjs}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# case <label> <expected-exit> <json>
case_is() {
  local label="$1" expect="$2" json="$3"
  local file="$TMP/report.json"
  printf '%s' "$json" > "$file"
  local actual
  node "$CHECKER" --report "$file" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expect" ]; then
    pass "$label"
  else
    fail "$label" "expected exit $expect, got $actual"
  fi
}

echo "licence cases, against $CHECKER"
echo

if [ ! -f "$CHECKER" ]; then
  fail "the checker exists" "no file at $CHECKER"
  echo; echo "licence cases: $PASSED passed, $FAILED failed"; exit 1
fi

GOOD='{"MIT":[{"name":"left-pad","version":"1.0.0"}],"Apache-2.0":[{"name":"axe","version":"2.0.0"}]}'

case_is "a well formed, compatible report passes" 0 "$GOOD"
case_is "an empty report fails: zero packages is not a clean result" 1 '{}'
case_is "a licence with no packages fails" 1 '{"MIT":[]}'
case_is "an empty licence expression fails" 1 '{"":[{"name":"a","version":"1"}]}'
case_is "a whitespace licence expression fails" 1 '{"   ":[{"name":"a","version":"1"}]}'
case_is "a package record with no name fails" 1 '{"MIT":[{"version":"1.0.0"}]}'
case_is "a package record with an empty name fails" 1 '{"MIT":[{"name":"","version":"1.0.0"}]}'
case_is "a package record with no version fails" 1 '{"MIT":[{"name":"a"}]}'
case_is "pnpm's versions array is accepted" 0 '{"MIT":[{"name":"a","versions":["1.0.0"]}]}'
case_is "an empty versions array fails" 1 '{"MIT":[{"name":"a","versions":[]}]}'
case_is "a versions array with an empty entry fails" 1 '{"MIT":[{"name":"a","versions":[""]}]}'
case_is "a package that is not an object fails" 1 '{"MIT":["left-pad"]}'
case_is "a licence whose value is not an array fails" 1 '{"MIT":{"name":"a"}}'
case_is "an unknown licence fails" 1 '{"Unknown":[{"name":"a","version":"1"}]}'
case_is "a top level array fails" 1 '[{"name":"a"}]'
case_is "a top level string fails" 1 '"MIT"'
case_is "malformed JSON fails" 2 '{not json'

# OSI approval is necessary, not sufficient. These are all OSI-approved and
# all incompatible with distributing them inside an AGPL-3.0-only work.
case_is "EPL-2.0 fails: OSI approved, not AGPL compatible" 1 '{"EPL-2.0":[{"name":"a","version":"1"}]}'
case_is "CDDL-1.0 fails: OSI approved, not AGPL compatible" 1 '{"CDDL-1.0":[{"name":"a","version":"1"}]}'
case_is "MS-PL fails: OSI approved, not AGPL compatible" 1 '{"MS-PL":[{"name":"a","version":"1"}]}'
case_is "GPL-2.0-only fails: OSI approved, not AGPL compatible" 1 '{"GPL-2.0-only":[{"name":"a","version":"1"}]}'
case_is "an OR expression with one bad half fails" 1 '{"MIT OR EPL-2.0":[{"name":"a","version":"1"}]}'
case_is "an AND expression with one bad half fails" 1 '{"MIT AND CDDL-1.0":[{"name":"a","version":"1"}]}'
case_is "a compatible OR expression passes" 0 '{"MIT OR Apache-2.0":[{"name":"a","version":"1"}]}'

# Round four, 7 September. The expression parser discarded parentheses and
# empty tokens, so an expression with no licence in it at all passed.
case_is "an empty expression, just parentheses, fails" 1 '{"()":[{"name":"a","version":"1"}]}'
case_is "parentheses with whitespace fails" 1 '{"( )":[{"name":"a","version":"1"}]}'
case_is "a dangling OR fails" 1 '{"MIT OR ":[{"name":"a","version":"1"}]}'
case_is "a dangling AND fails" 1 '{"MIT AND ":[{"name":"a","version":"1"}]}'
case_is "a leading operator fails" 1 '{" OR MIT":[{"name":"a","version":"1"}]}'
case_is "WITH is an exception, not a second licence" 1 '{"MIT WITH Apache-2.0":[{"name":"a","version":"1"}]}'
case_is "a real WITH exception passes" 0 '{"Apache-2.0 WITH LLVM-exception":[{"name":"a","version":"1"}]}'
case_is "unbalanced parentheses fail" 1 '{"(MIT OR ISC":[{"name":"a","version":"1"}]}'
case_is "a bare operator fails" 1 '{"OR":[{"name":"a","version":"1"}]}'
case_is "a nested compatible expression passes" 0 '{"(MIT OR ISC) AND Apache-2.0":[{"name":"a","version":"1"}]}'

# Round five, 7 September. WITH was parsed and then thrown away: any token
# spelled like an exception was consumed without a policy lookup, so an
# invented exception received a compatibility declaration.
case_is "an invented exception fails" 1 '{"MIT WITH Invented-Exception":[{"name":"a","version":"1"}]}'
case_is "a plausible but unknown exception fails" 1 '{"Apache-2.0 WITH Nathan-exception":[{"name":"a","version":"1"}]}'
case_is "an unknown exception on a compatible licence still fails" 1 '{"GPL-3.0-only WITH Made-Up-exception":[{"name":"a","version":"1"}]}'
case_is "a known exception passes" 0 '{"Apache-2.0 WITH LLVM-exception":[{"name":"a","version":"1"}]}'
case_is "a known exception inside brackets passes" 0 '{"(GPL-3.0-only WITH Classpath-exception-2.0) OR MIT":[{"name":"a","version":"1"}]}'
case_is "an unknown licence fails even when spelled like one" 1 '{"Invented-1.0":[{"name":"a","version":"1"}]}'

echo
echo "licence cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
