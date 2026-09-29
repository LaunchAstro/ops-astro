#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The pull request size report, against throwaway repositories.
#
# The size is reported, not limited (owner, 29 September 2026): the script
# measures and prints its report, total, per file and moved lines, and always
# exits 0, so the required check 'pull request size' never blocks. The cases
# that once expected a block now expect a pass and check the report instead,
# so the measuring stays proven. Waiver labels change nothing.
#
# Usage: tests/ci/pr-size-cases.sh [path-to-script]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIZER="${1:-$REPO_ROOT/scripts/pr-size.mjs}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

# Every case folder lives under one scratch folder, removed however the run
# ends, so an interrupted or failing run leaves nothing in the temp folder.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pr-size-cases.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

new_repo() {
  local dir
  dir="$(mktemp -d "$SCRATCH/case.XXXXXX")"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name "Size Test"
  git -C "$dir" config user.email "size-test@example.invalid"
  git -C "$dir" config commit.gpgsign false
  printf 'seed\n' > "$dir/seed.txt"
  git -C "$dir" add seed.txt >/dev/null
  git -C "$dir" commit -qm "seed"
  echo "$dir"
}

# add_lines <dir> <path> <count>
add_lines() {
  local dir="$1" path="$2" count="$3"
  mkdir -p "$dir/$(dirname "$path")"
  : > "$dir/$path"
  local i=1
  while [ "$i" -le "$count" ]; do printf 'line %s\n' "$i" >> "$dir/$path"; i=$((i + 1)); done
  git -C "$dir" add "$path" >/dev/null
  git -C "$dir" commit -qm "feat: $path"
}

# Measures from the seed commit. Sets STATUS and REPORT, like run_last_commit.
run_sizer() {
  local dir="$1" labels="$2"
  REPORT="$(cd "$dir" && BASE_SHA="$(git rev-list --max-parents=0 HEAD)" HEAD_SHA="$(git rev-parse HEAD)" \
      PR_LABELS="$labels" node "$SIZER" 2>&1)"
  STATUS=$?
}

# reports <name> <text>: the last report holds the text, a fixed string.
reports() {
  if printf '%s\n' "$REPORT" | grep -qF -- "$2"; then pass "$1"; else fail "$1" "report was: $REPORT"; fi
}

# The report is never a refusal: no error annotation, and the closing line
# says the size is not limited.
not_a_refusal() {
  if printf '%s\n' "$REPORT" | grep -q '^::error::'; then
    fail "$1" "the report carries an error annotation: $REPORT"
  else
    reports "$1" 'pr-size: the size is reported, not limited; this check never blocks.'
  fi
}

# Moved lines. A pull request that only moves code starts from a base that
# already holds it, so these cases measure the last commit alone and keep the
# report for the per-file assertions.
# write_block <dir> <path> <from> <to> [indent]
write_block() {
  local dir="$1" path="$2" from="$3" to="$4" indent="${5:-}"
  mkdir -p "$dir/$(dirname "$path")"
  local i="$from"
  while [ "$i" -le "$to" ]; do
    printf '%sconst value_%s = compute(%s);\n' "$indent" "$i" "$i" >> "$dir/$path"
    i=$((i + 1))
  done
}

commit_all() { git -C "$1" add -A >/dev/null; git -C "$1" commit -qm "$2"; }

# Sets STATUS and REPORT rather than echoing, so the report survives.
run_last_commit() {
  local dir="$1" labels="$2"
  REPORT="$(cd "$dir" && BASE_SHA="$(git rev-parse HEAD~1)" HEAD_SHA="$(git rev-parse HEAD)" \
      PR_LABELS="$labels" node "$SIZER" 2>&1)"
  STATUS=$?
}

echo "pr-size cases, against $SIZER"
echo

dir="$(new_repo)"; add_lines "$dir" "src/small.ts" 50
run_sizer "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a small change passes (exit 0)" || fail "a small change passes" "expected 0, got $status: $REPORT"
reports "a small change is reported" 'pr-size: 50 changed lines of non-test code across 1 file(s).'
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "src/big.ts" 500
run_sizer "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "500 changed lines, once over the ceiling, pass (exit 0)" \
  || fail "500 changed lines, once over the ceiling, pass" "expected 0, got $status: $REPORT"
reports "500 changed lines are reported in full" 'pr-size: 500 changed lines of non-test code across 1 file(s).'
not_a_refusal "500 changed lines draw no refusal"
rm -rf "$dir"

# Waiver labels no longer gate anything: the same change gives the same exit
# and the same report with either label or none.
dir="$(new_repo)"; add_lines "$dir" "src/a.ts" 200; add_lines "$dir" "src/b.ts" 250
run_sizer "$dir" ""; bare_status="$STATUS"; bare_report="$REPORT"
for label in size-waiver-coherence size-waiver-mechanical; do
  run_sizer "$dir" "$label"
  if [ "$STATUS" = "0" ] && [ "$bare_status" = "0" ] && [ "$REPORT" = "$bare_report" ]; then
    pass "$label changes nothing (exit 0, same report)"
  else
    fail "$label changes nothing" "without it: $bare_status, $bare_report; with it: $STATUS, $REPORT"
  fi
done
rm -rf "$dir"

# The per-file cap no longer gates: a single hand-written file of 600 lines
# passes, and the report still counts it.
dir="$(new_repo)"; add_lines "$dir" "src/huge.ts" 600
run_sizer "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "one hand-written file of 600 lines passes (exit 0)" \
  || fail "one hand-written file of 600 lines passes" "expected 0, got $status: $REPORT"
reports "one hand-written file of 600 lines is reported per file" \
  'pr-size:   src/huge.ts: 600 counted, 0 treated as moved (600 changed)'
not_a_refusal "one hand-written file of 600 lines draws no refusal"
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "pnpm-lock.yaml" 600
run_sizer "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a generated file of 600 lines passes (exit 0)" \
  || fail "a generated file of 600 lines passes" "expected 0, got $status: $REPORT"
reports "a generated file still counts towards the total" 'pr-size: 600 changed lines of non-test code across 1 file(s).'
rm -rf "$dir"

# Moved lines are not counted (issue 110). A split of a large file into
# smaller ones is read as a move by a reviewer, so it is measured as one: only
# the lines git does not mark as moved (indentation changes allowed) count,
# per file and in the total.
# big.ts keeps one line of its own, so git reads it as a 500-line deletion,
# over 400 lines in one file, rather than as a rename of one half.
dir="$(new_repo)"; mkdir -p "$dir/src"; printf '// big\n' > "$dir/src/big.ts"
write_block "$dir" "src/big.ts" 1 500; commit_all "$dir" "base"
printf '// big\n' > "$dir/src/big.ts"; write_block "$dir" "src/a.ts" 1 250; write_block "$dir" "src/b.ts" 251 500
commit_all "$dir" "split big.ts"
raw_max="$(git -C "$dir" diff --numstat HEAD~1 HEAD | awk '{ changed = $1 + $2; if (changed > max) max = changed } END { print max + 0 }')"
if [ "$raw_max" -gt 400 ]; then
  pass "Sol proof, criterion 2: the named pure-move case crosses 400 raw lines in one file"
else
  fail "Sol proof, criterion 2: the named pure-move case crosses 400 raw lines in one file" \
    "largest raw per-file change is $raw_max, so this case only exercises the total"
fi
run_last_commit "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a pure move of 500 lines into two files passes (exit 0)" \
  || fail "a pure move of 500 lines into two files passes" "expected 0, got $status: $REPORT"
reports "a pure move of 500 lines is reported as moved" 'pr-size: 1000 moved lines of non-test code, not counted.'
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "src/hand.ts" 401
run_sizer "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "401 hand-written lines in one file pass (exit 0)" \
  || fail "401 hand-written lines in one file pass" "expected 0, got $status: $REPORT"
reports "401 hand-written lines in one file are reported" 'pr-size:   src/hand.ts: 401 counted, 0 treated as moved (401 changed)'
rm -rf "$dir"

dir="$(new_repo)"; write_block "$dir" "src/wrap.ts" 1 450; commit_all "$dir" "base"
: > "$dir/src/wrap.ts"
printf 'export function run() {\n' >> "$dir/src/wrap.ts"
write_block "$dir" "src/wrap.ts" 1 450 "  "
printf '}\n' >> "$dir/src/wrap.ts"
commit_all "$dir" "wrap into a named step"
run_last_commit "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a block re-indented into a function counts as moved (exit 0)" \
  || fail "a block re-indented into a function counts as moved" "expected 0, got $status: $REPORT"
echo "$REPORT" | grep -qF 'src/wrap.ts: 2 counted, 900 treated as moved (902 changed)' \
  && pass "the report names the re-indented lines as moved" \
  || fail "the report names the re-indented lines as moved" "report was: $REPORT"
rm -rf "$dir"

# Moved and then edited: the edited lines are new text and count, on both
# sides, while the untouched rest of the block is still a move. big.ts keeps
# its first hundred lines, so git reads it as modified, not renamed.
dir="$(new_repo)"; write_block "$dir" "src/big.ts" 1 500; commit_all "$dir" "base"
: > "$dir/src/big.ts"; write_block "$dir" "src/big.ts" 1 100
write_block "$dir" "src/moved.ts" 101 200
i=201; while [ "$i" -le 260 ]; do printf 'const value_%s = edited(%s);\n' "$i" "$i" >> "$dir/src/moved.ts"; i=$((i + 1)); done
write_block "$dir" "src/moved.ts" 261 500
commit_all "$dir" "move and edit"
run_last_commit "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a moved and edited block passes when its edits are small (exit 0)" \
  || fail "a moved and edited block passes when its edits are small" "expected 0, got $status: $REPORT"
echo "$REPORT" | grep -qF 'src/moved.ts: 60 counted, 340 treated as moved (400 changed)' \
  && echo "$REPORT" | grep -qF 'src/big.ts: 60 counted, 340 treated as moved (400 changed)' \
  && pass "a moved and edited block counts its edited lines" \
  || fail "a moved and edited block counts its edited lines" "report was: $REPORT"
rm -rf "$dir"

dir="$(new_repo)"; write_block "$dir" "src/big.ts" 1 600; commit_all "$dir" "base"
: > "$dir/src/big.ts"; write_block "$dir" "src/big.ts" 1 100
write_block "$dir" "src/moved.ts" 101 130
i=131; while [ "$i" -le 540 ]; do printf 'const value_%s = edited(%s);\n' "$i" "$i" >> "$dir/src/moved.ts"; i=$((i + 1)); done
write_block "$dir" "src/moved.ts" 541 600
commit_all "$dir" "move and rewrite"
run_last_commit "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a moved block with 410 edited lines passes (exit 0)" \
  || fail "a moved block with 410 edited lines passes" "expected 0, got $status: $REPORT"
reports "a moved block with 410 edited lines counts them" 'pr-size:   src/moved.ts: 410 counted, 90 treated as moved (500 changed)'
rm -rf "$dir"

# Test lines are never counted, so a move out of a test file is not a move:
# otherwise code could be written uncounted in a test and moved uncounted
# into the product.
dir="$(new_repo)"; write_block "$dir" "tests/helper.test.ts" 1 500; commit_all "$dir" "base"
: > "$dir/tests/helper.test.ts"; write_block "$dir" "tests/helper.test.ts" 1 50
write_block "$dir" "src/helper.ts" 51 500
commit_all "$dir" "move test code into the product"
run_last_commit "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "code moved out of a test file passes (exit 0)" \
  || fail "code moved out of a test file passes" "expected 0, got $status: $REPORT"
reports "code moved out of a test file counts in full" 'pr-size:   src/helper.ts: 450 counted, 0 treated as moved (450 changed)'
rm -rf "$dir"

# A literal filename can equal the report name of a rename. Its new lines
# must not inherit the rename's moved-line count through that shared name.
dir="$(new_repo)"
mkdir -p "$dir/src/a.ts => src"
write_block "$dir" "src/a.ts" 1 1200
printf 'const literal = true;\n' > "$dir/src/a.ts => src/b.ts"
commit_all "$dir" "base with colliding names"
write_block "$dir" "src/b.ts" 1 700
rm "$dir/src/a.ts"
write_block "$dir" "src/c.ts" 701 1200
write_block "$dir" "src/a.ts => src/b.ts" 3001 3500
commit_all "$dir" "rename, move, and add handwritten lines"
run_last_commit "$dir" ""; status="$STATUS"
if [ "$status" = "0" ] && [[ "$REPORT" == *'"src/a.ts => src/b.ts": 500 counted, 0 treated as moved (500 changed)'* ]]; then
  pass "Sol proof, criterion 1: a filename matching a rename cannot hide 500 new lines"
else
  fail "Sol proof, criterion 1: a filename matching a rename cannot hide 500 new lines" \
    "expected exit 0 with 500 counted for the literal path, got status $status: $REPORT"
fi
unique_report_names="$(printf '%s\n' "$REPORT" | grep '^pr-size:   ' | sed -E 's/: [0-9]+ counted,.*$//' | sort -u | wc -l | tr -d '[:space:]')"
if [ "$unique_report_names" = "3" ]; then
  pass "Sol proof, criterion 4: the report distinguishes a literal path from a rename"
else
  fail "Sol proof, criterion 4: the report distinguishes a literal path from a rename" \
    "three changed files have only $unique_report_names distinct report names: $REPORT"
fi
rm -rf "$dir"

# The check never blocks, even when it cannot measure: a missing or unknown
# revision is a warning, not a failure.
dir="$(new_repo)"
REPORT="$(cd "$dir" && env -u BASE_SHA -u HEAD_SHA node "$SIZER" 2>&1)"; STATUS=$?
[ "$STATUS" = "0" ] && pass "no revisions to measure passes with a warning (exit 0)" \
  || fail "no revisions to measure passes with a warning" "expected 0, got $STATUS: $REPORT"
reports "no revisions to measure is a warning" '::warning::pr-size could not measure this pull request'
REPORT="$(cd "$dir" && BASE_SHA=0000000000000000000000000000000000000000 HEAD_SHA="$(git rev-parse HEAD)" \
    node "$SIZER" 2>&1)"; STATUS=$?
[ "$STATUS" = "0" ] && pass "an unknown revision passes with a warning (exit 0)" \
  || fail "an unknown revision passes with a warning" "expected 0, got $STATUS: $REPORT"
reports "an unknown revision is a warning" '::warning::pr-size could not measure this pull request'
# Hostile: a revision carrying a line break and a workflow command. Nothing
# printed, git's own stderr included, may start a line with it.
REPORT="$(cd "$dir" && BASE_SHA=$'nope\n::error::planted-canary' HEAD_SHA="$(git rev-parse HEAD)" \
    node "$SIZER" 2>&1)"; STATUS=$?
if [ "$STATUS" = "0" ] && ! printf '%s\n' "$REPORT" | grep -q '^::error::'; then
  pass "a revision carrying a workflow command cannot start one (exit 0)"
else
  fail "a revision carrying a workflow command cannot start one" "status $STATUS: $REPORT"
fi
rm -rf "$dir"

echo
echo "pr-size cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
