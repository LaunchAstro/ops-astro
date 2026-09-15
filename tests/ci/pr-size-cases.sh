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

new_repo() {
  local dir
  dir="$(mktemp -d)"
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
