#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The commit-range check, tested against throwaway repositories.
#
# Finding 7 of the sweep: commitlint and the provenance trailers were listed
# as blocking from commit one, but ran only in a local hook. A local hook is
# advice, not a gate: it is absent on a fresh clone until `pnpm install`, and
# `--no-verify` skips it. Anything that must hold has to be checked in CI, on
# the range of commits a pull request actually introduces.
#
# Usage: tests/ci/commit-range-cases.sh [path-to-checker]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="${1:-$REPO_ROOT/scripts/commit-range-check.mjs}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

AGENT_TRAILERS=$'\n\nAssisted-by: LLM\nAgent-model: claude-opus-5\nAgent-tool: Claude Code'
HUMAN_TRAILER=$'\n\nSigned-off-by: A Person <person@example.invalid>'

new_repo() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name "Range Test"
  git -C "$dir" config user.email "range-test@example.invalid"
  git -C "$dir" config commit.gpgsign false
  printf 'seed\n' > "$dir/seed.txt"
  git -C "$dir" add seed.txt >/dev/null
  git -C "$dir" commit -qm "chore: seed$AGENT_TRAILERS"
  echo "$dir"
}

# commit <dir> <message>
commit() {
  local dir="$1" msg="$2"
  printf '%s\n' "$RANDOM" >> "$dir/seed.txt"
  git -C "$dir" add seed.txt >/dev/null
  git -C "$dir" commit -qm "$msg"
}

run_checker() {
  local dir="$1"
  ( cd "$dir" && BASE_SHA="$(git rev-list --max-parents=0 HEAD)" HEAD_SHA="$(git rev-parse HEAD)" \
      node "$CHECKER" >/dev/null 2>&1; echo $? )
}

echo "commit-range cases, against $CHECKER"
echo

if [ ! -f "$CHECKER" ]; then
  fail "the checker exists" "no file at $CHECKER; nothing enforces commit messages or provenance in CI"
  echo
  echo "commit-range cases: $PASSED passed, $FAILED failed"
  exit 1
fi

# 1. a clean range passes
dir="$(new_repo)"
commit "$dir" "feat: something reasonable$AGENT_TRAILERS"
status="$(run_checker "$dir")"
[ "$status" = "0" ] && pass "a clean range passes (exit 0)" \
  || fail "a clean range passes" "expected exit 0, got $status"
rm -rf "$dir"

# 2. a message that is not a conventional commit fails
dir="$(new_repo)"
commit "$dir" "made some changes$AGENT_TRAILERS"
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "a non-conventional subject fails (exit 1)" \
  || fail "a non-conventional subject fails" "expected exit 1, got $status"
rm -rf "$dir"

# 3. an unknown type fails
dir="$(new_repo)"
commit "$dir" "wibble: not a type we use$AGENT_TRAILERS"
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "an unknown type fails (exit 1)" \
  || fail "an unknown type fails" "expected exit 1, got $status"
rm -rf "$dir"

# 4. no provenance at all fails
dir="$(new_repo)"
commit "$dir" "fix: no provenance of any kind"
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "a commit with no provenance fails (exit 1)" \
  || fail "a commit with no provenance fails" "expected exit 1, got $status"
rm -rf "$dir"

# 5. partial agent trailers fail
dir="$(new_repo)"
commit "$dir" "fix: half the trailers"$'\n\nAssisted-by: LLM'
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "partial agent trailers fail (exit 1)" \
  || fail "partial agent trailers fail" "expected exit 1, got $status"
rm -rf "$dir"

# 6. a human sign-off is provenance on its own
dir="$(new_repo)"
commit "$dir" "docs: typed by a person$HUMAN_TRAILER"
status="$(run_checker "$dir")"
[ "$status" = "0" ] && pass "a human sign-off is accepted as provenance (exit 0)" \
  || fail "a human sign-off is accepted as provenance" "expected exit 0, got $status"
rm -rf "$dir"

# 7. every commit in the range is checked, not just the tip
dir="$(new_repo)"
commit "$dir" "fix: no provenance in the middle"
commit "$dir" "feat: a clean tip$AGENT_TRAILERS"
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "a bad commit behind a clean tip still fails (exit 1)" \
  || fail "a bad commit behind a clean tip still fails" "expected exit 1, got $status"
rm -rf "$dir"

# Round four, 7 September. The checker read trailer names and never their
# values, so a commit could carry the shape of provenance with nothing in it.
EMPTY_TRAILERS=$'\n\nAssisted-by:\nAgent-model:\nAgent-tool:'
dir="$(new_repo)"
commit "$dir" "fix: provenance with no values$EMPTY_TRAILERS"
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "empty trailer values fail (exit 1)" \
  || fail "empty trailer values fail" "expected exit 1, got $status; the names were present and the values were blank"
rm -rf "$dir"

dir="$(new_repo)"
commit "$dir" "fix: whitespace provenance"$'\n\nAssisted-by:   \nAgent-model: \nAgent-tool:\t'
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "whitespace-only trailer values fail (exit 1)" \
  || fail "whitespace-only trailer values fail" "expected exit 1, got $status"
rm -rf "$dir"

dir="$(new_repo)"
commit "$dir" "docs: an empty sign-off"$'\n\nSigned-off-by:'
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "an empty Signed-off-by is not provenance (exit 1)" \
  || fail "an empty Signed-off-by is not provenance" "expected exit 1, got $status"
rm -rf "$dir"

dir="$(new_repo)"
commit "$dir" "docs: a sign-off with no email"$'\n\nSigned-off-by: Someone'
status="$(run_checker "$dir")"
[ "$status" = "1" ] && pass "a sign-off without an email fails (exit 1)" \
  || fail "a sign-off without an email fails" "expected exit 1, got $status"
rm -rf "$dir"

# The root commit must be checked too. A range computed as HEAD..HEAD selects
# nothing and then reports success.
dir="$(new_repo)"
status="$( cd "$dir" && BASE_SHA="$(git rev-parse HEAD)" HEAD_SHA="$(git rev-parse HEAD)" \
    node "$CHECKER" >/dev/null 2>&1; echo $? )"
[ "$status" = "0" ] && pass "an empty range is honest about selecting nothing (exit 0)" \
  || fail "an empty range is honest about selecting nothing" "expected exit 0, got $status"
rm -rf "$dir"

# A repository whose only commit is bad must fail, not pass because the range
# excluded the root.
dir="$(mktemp -d)"
git -C "$dir" init -q -b main
git -C "$dir" config user.name "Range Test"
git -C "$dir" config user.email "range-test@example.invalid"
git -C "$dir" config commit.gpgsign false
printf 'seed\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null
git -C "$dir" commit -qm "no type and no provenance at all"
status="$( cd "$dir" && BASE_SHA="$(git rev-parse HEAD)" HEAD_SHA="$(git rev-parse HEAD)" \
    HUB_RANGE_INCLUDE_ROOT=1 node "$CHECKER" >/dev/null 2>&1; echo $? )"
[ "$status" = "1" ] && pass "the root commit is checked when asked (exit 1)" \
  || fail "the root commit is checked when asked" "expected exit 1, got $status; a first push would never check its own first commit"
rm -rf "$dir"

# Placeholder and partial declarations remain invalid beside a human sign-off.
for trailers in \
  $'Assisted-by: LLM\nAgent-model: <actual-model-id>\nAgent-tool: test-tool' \
  $'Assisted-by: LLM\nAgent-model: TODO\nAgent-tool: test-tool' \
  $'Assisted-by: LLM\nAgent-model: fixture-model\nAgent-tool: [actual tool]' \
  $'Assisted-by: LLM\nAgent-model: fixture-model\nAgent-tool: test-tool\nAgent-model:' \
  $'Signed-off-by: A Person <person@example.invalid>\nAssisted-by: LLM'; do
  dir="$(new_repo)"
  commit "$dir" "fix: invalid declaration"$'\n\n'"$trailers"
  status="$(run_checker "$dir")"
  [ "$status" = "1" ] && pass "placeholder or partial declaration fails (exit 1)" \
    || fail "placeholder or partial declaration fails" "expected exit 1, got $status"
  rm -rf "$dir"
done

# The assistance value is a literal contract, including duplicate declarations.
for trailers in \
  $'Assisted-by: automation\nAgent-model: fixture-model\nAgent-tool: fixture-tool' \
  $'Assisted-by: llm\nAgent-model: fixture-model\nAgent-tool: fixture-tool' \
  $'Assisted-by: LLM\nAgent-model: fixture-model\nAgent-tool: fixture-tool\nAssisted-by: automation' \
  $'Assisted-by: LLM\nAgent-model: fixture-model\nAgent-tool: fixture-tool\nAgent-model: conflicting-model'; do
  dir="$(new_repo)"
  commit "$dir" "fix: invalid assistance"$'\n\n'"$trailers"
  status="$(run_checker "$dir")"
  [ "$status" = "1" ] && pass "invalid assistance or conflicting declarations fail (exit 1)" \
    || fail "invalid assistance or conflicting declarations fail" "expected exit 1, got $status"
  rm -rf "$dir"
done

echo
echo "commit-range cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
