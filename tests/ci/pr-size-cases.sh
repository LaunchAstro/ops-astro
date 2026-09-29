#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The pull request size gate and its waivers, against throwaway repositories.
#
# Round four, finding at rank 15: the mechanical waiver lifted the per-file
# handwritten cap as well as the total, so one label let a single file of any
# size through. The two limits exist for different reasons. The total is about
# how much a reviewer can hold; the per-file cap is about a file nobody can
# read in one sitting. A migration or a lock file is genuinely unreadable and
# genuinely mechanical, and it is caught by the generated-file patterns
# without anyone applying a label.
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

run_sizer() {
  local dir="$1" labels="$2"
  ( cd "$dir" && BASE_SHA="$(git rev-list --max-parents=0 HEAD)" HEAD_SHA="$(git rev-parse HEAD)" \
      PR_LABELS="$labels" node "$SIZER" >/dev/null 2>&1; echo $? )
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
status="$(run_sizer "$dir" "")"
[ "$status" = "0" ] && pass "a small change passes (exit 0)" || fail "a small change passes" "expected 0, got $status"
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "src/big.ts" 500
status="$(run_sizer "$dir" "")"
[ "$status" = "1" ] && pass "over the total ceiling fails (exit 1)" || fail "over the total ceiling fails" "expected 1, got $status"
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "src/a.ts" 200; add_lines "$dir" "src/b.ts" 250
status="$(run_sizer "$dir" "size-waiver-coherence")"
[ "$status" = "0" ] && pass "the coherence waiver lifts the total (exit 0)" || fail "the coherence waiver lifts the total" "expected 0, got $status"
rm -rf "$dir"

# The one round four found. A single handwritten file over the per-file cap
# must not be waved through by the mechanical label.
dir="$(new_repo)"; add_lines "$dir" "src/huge.ts" 600
status="$(run_sizer "$dir" "size-waiver-mechanical")"
[ "$status" = "1" ] && pass "the mechanical waiver does not lift the per-file cap (exit 1)" \
  || fail "the mechanical waiver does not lift the per-file cap" "expected 1, got $status; one label let a single unreadable file through"
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "src/huge.ts" 600
status="$(run_sizer "$dir" "size-waiver-coherence")"
[ "$status" = "1" ] && pass "the coherence waiver does not lift the per-file cap (exit 1)" \
  || fail "the coherence waiver does not lift the per-file cap" "expected 1, got $status"
rm -rf "$dir"

# A genuinely generated file is caught by its pattern, with no label needed.
dir="$(new_repo)"; add_lines "$dir" "pnpm-lock.yaml" 600
status="$(run_sizer "$dir" "size-waiver-mechanical")"
[ "$status" = "0" ] && pass "a generated file over the cap passes on its pattern (exit 0)" \
  || fail "a generated file over the cap passes on its pattern" "expected 0, got $status"
rm -rf "$dir"

# Moved lines do not count (issue 110). A split of a large file into smaller
# ones is read as a move by a reviewer, so it is measured as one: only the
# lines git does not mark as moved (indentation changes allowed) count
# towards the per-file cap and the total.
# big.ts keeps one line of its own, so git reads it as a 500-line deletion,
# over the per-file cap on its own, rather than as a rename of one half.
dir="$(new_repo)"; mkdir -p "$dir/src"; printf '// big\n' > "$dir/src/big.ts"
write_block "$dir" "src/big.ts" 1 500; commit_all "$dir" "base"
printf '// big\n' > "$dir/src/big.ts"; write_block "$dir" "src/a.ts" 1 250; write_block "$dir" "src/b.ts" 251 500
commit_all "$dir" "split big.ts"
raw_max="$(git -C "$dir" diff --numstat HEAD~1 HEAD | awk '{ changed = $1 + $2; if (changed > max) max = changed } END { print max + 0 }')"
if [ "$raw_max" -gt 400 ]; then
  pass "Sol proof, criterion 2: the named pure-move case crosses the raw per-file cap"
else
  fail "Sol proof, criterion 2: the named pure-move case crosses the raw per-file cap" \
    "largest raw per-file change is $raw_max, so this case only exercises the total"
fi
run_last_commit "$dir" ""; status="$STATUS"
[ "$status" = "0" ] && pass "a pure move of 500 lines into two files passes (exit 0)" \
  || fail "a pure move of 500 lines into two files passes" "expected 0, got $status: $REPORT"
rm -rf "$dir"

dir="$(new_repo)"; add_lines "$dir" "src/hand.ts" 401
status="$(run_sizer "$dir" "size-waiver-coherence")"
[ "$status" = "1" ] && pass "401 hand-written lines in one file still fail the per-file cap (exit 1)" \
  || fail "401 hand-written lines in one file still fail the per-file cap" "expected 1, got $status"
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
run_last_commit "$dir" "size-waiver-coherence"; status="$STATUS"
[ "$status" = "1" ] && pass "a moved block with 410 edited lines fails the per-file cap (exit 1)" \
  || fail "a moved block with 410 edited lines fails the per-file cap" "expected 1, got $status: $REPORT"
rm -rf "$dir"

# Test lines are never counted, so a move out of a test file is not a move:
# otherwise code could be written uncounted in a test and moved uncounted
# into the product.
dir="$(new_repo)"; write_block "$dir" "tests/helper.test.ts" 1 500; commit_all "$dir" "base"
: > "$dir/tests/helper.test.ts"; write_block "$dir" "tests/helper.test.ts" 1 50
write_block "$dir" "src/helper.ts" 51 500
commit_all "$dir" "move test code into the product"
run_last_commit "$dir" "size-waiver-coherence"; status="$STATUS"
[ "$status" = "1" ] && pass "code moved out of a test file counts in full (exit 1)" \
  || fail "code moved out of a test file counts in full" "expected 1, got $status: $REPORT"
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
run_last_commit "$dir" "size-waiver-coherence"; status="$STATUS"
if [ "$status" = "1" ] && [[ "$REPORT" == *'over the per-file cap'* ]]; then
  pass "Sol proof, criterion 1: a filename matching a rename cannot hide 500 new lines"
else
  fail "Sol proof, criterion 1: a filename matching a rename cannot hide 500 new lines" \
    "expected per-file refusal for 500 new lines, got status $status: $REPORT"
fi
rm -rf "$dir"

# Removing a waiver label must change the result, which is only true if the
# workflow reruns on a label change. That is a workflow setting, checked here
# because the rule is meaningless without it.
if grep -qE 'types:.*(labeled|unlabeled)' "$REPO_ROOT/.github/workflows/ci.yml"; then
  pass "the workflow reruns when a label changes"
else
  fail "the workflow reruns when a label changes" "ci.yml does not list labeled/unlabeled, so removing a waiver leaves the old green result standing"
fi

echo
echo "pr-size cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
