#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Negative tests for the contamination gate.
#
# Each case builds a throwaway git repository in a temporary directory, drops
# the gate in, and asserts the gate catches something it must catch. These
# are the cases the sweep of 6 September proved the first version missed, so
# they stay here as regression tests: if any of them stops failing the way it
# should, the gate has lost coverage again.
#
# Usage:  tests/gate/gate-cases.sh [path-to-gate-dir]
# Default gate dir is scripts/gate beside this repository.
#
# Exit 0 when every case passes, 1 when any case fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE_DIR="${1:-$REPO_ROOT/scripts/gate}"
GATE_DIR="$(cd "$GATE_DIR" && pwd)"

PASSED=0
FAILED=0

pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

# A throwaway repository with the gate installed. Never the real one.
new_repo() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/scripts/gate" "$dir/tests/gate"
  cp "$GATE_DIR"/* "$dir/scripts/gate/" 2>/dev/null
  cp "$REPO_ROOT/tests/gate/canary.txt" "$dir/tests/gate/" 2>/dev/null
  cp "$REPO_ROOT/tests/gate/shape-canary.txt" "$dir/tests/gate/" 2>/dev/null
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name "Gate Test"
  git -C "$dir" config user.email "gate-test@example.invalid"
  git -C "$dir" config commit.gpgsign false
  echo "$dir"
}

run_gate() {
  local dir="$1"; shift
  ( cd "$dir" && python3 scripts/gate/sweep.py "$@" 2>&1 )
}

gate_status() {
  local dir="$1"; shift
  ( cd "$dir" && python3 scripts/gate/sweep.py "$@" >/dev/null 2>&1; echo $? )
}

# The canary term, read from the fixture rather than typed here, so this file
# never becomes a second place a denied term lives.
CANARY="$(grep -oE '[Kk]wathorne [A-Za-z]+ [A-Za-z]+' "$REPO_ROOT/tests/gate/canary.txt" | head -1)"
if [ -z "$CANARY" ]; then
  echo "harness: cannot read the canary term from tests/gate/canary.txt" >&2
  exit 1
fi

echo "gate cases, against $GATE_DIR"
echo

# ---------------------------------------------------------------------------
echo "A. a contaminated blob that is staged but not in the working tree"
# Stage the bad content, then clean the working copy without staging the
# cleanup. A scanner that reads the working tree sees nothing.
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
printf 'a note about %s\n' "$CANARY" > "$dir/notes.txt"
git -C "$dir" add notes.txt >/dev/null
printf 'a note about nothing at all\n' > "$dir/notes.txt"
status="$(gate_status "$dir" --staged)"
if [ "$status" = "1" ]; then
  pass "staged blob contents are scanned (exit 1)"
else
  fail "staged blob contents are scanned" "expected exit 1, got $status; the scanner read the working tree, not the index"
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
echo "B. a contaminated file added and then deleted in history"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
printf 'a note about %s\n' "$CANARY" > "$dir/leak.txt"
git -C "$dir" add leak.txt >/dev/null && git -C "$dir" commit -qm "add"
git -C "$dir" rm -q leak.txt && git -C "$dir" commit -qm "delete"
status="$(gate_status "$dir" --range)"
if [ "$status" = "1" ]; then
  pass "the outgoing commit range is scanned, deletions included (exit 1)"
else
  fail "the outgoing commit range is scanned" "expected exit 1, got $status; the deleted blob survives in history unchecked"
fi
# and prove the working-tree sweep alone does not see it, which is the point
tree_status="$(gate_status "$dir")"
if [ "$tree_status" = "0" ]; then
  pass "the working-tree sweep alone reports clean, which is why B is needed"
else
  fail "the working-tree sweep alone reports clean" "expected exit 0, got $tree_status"
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
echo "C. a denied path inside a directory the content scan excludes"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
printf 'SECRET_KEY=notreal\n' > "$dir/tests/gate/.env"
git -C "$dir" add -f tests/gate/.env >/dev/null
status="$(gate_status "$dir" --staged)"
if [ "$status" = "1" ]; then
  pass "path checks run before content exclusions (exit 1)"
else
  fail "path checks run before content exclusions" "expected exit 1, got $status; the excluded directory hid a denied path"
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
echo "D. a file the scanner cannot read"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
printf 'text \000 with a null byte and no declared reason\n' > "$dir/opaque.dat"
git -C "$dir" add opaque.dat >/dev/null
status="$(gate_status "$dir" --staged)"
if [ "$status" = "1" ]; then
  pass "unreadable or binary content fails closed (exit 1)"
else
  fail "unreadable or binary content fails closed" "expected exit 1, got $status; the scanner skipped what it could not read"
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
echo "E. a four-word denied phrase"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
FOUR="$(grep -oE '[Kk]wathorne [A-Za-z]+ [A-Za-z]+ [A-Za-z]+' "$REPO_ROOT/tests/gate/canary.txt" | head -1)"
if [ -z "$FOUR" ]; then
  fail "a four-word phrase can match" "no four-word canary in tests/gate/canary.txt to test with"
else
  printf 'a note about %s\n' "$FOUR" > "$dir/four.txt"
  git -C "$dir" add four.txt >/dev/null
  status="$(gate_status "$dir" --staged)"
  if [ "$status" = "1" ]; then
    pass "a four-word denied phrase matches (exit 1)"
  else
    fail "a four-word denied phrase matches" "expected exit 1, got $status; the phrase cap is below four words"
  fi
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
echo "F. the shape rules fire on synthetic personal and machine data"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
if [ -f "$REPO_ROOT/tests/gate/shape-canary.txt" ]; then
  cp "$REPO_ROOT/tests/gate/shape-canary.txt" "$dir/copied-shapes.txt"
  git -C "$dir" add copied-shapes.txt >/dev/null
  status="$(gate_status "$dir" --staged)"
  if [ "$status" = "1" ]; then
    pass "shape rules fire outside the fixture (exit 1)"
  else
    fail "shape rules fire outside the fixture" "expected exit 1, got $status; the promised shape rules are absent"
  fi
else
  fail "shape rules fire outside the fixture" "tests/gate/shape-canary.txt does not exist"
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
echo "G. the self-test proves the gate, and exit 2 means the private list is absent"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
status="$(gate_status "$dir" --self-test)"
if [ "$status" = "0" ]; then
  pass "the self-test passes on an intact gate (exit 0)"
else
  fail "the self-test passes on an intact gate" "expected exit 0, got $status"
fi
status="$( cd "$dir" && HUB_GATE_TERMS=/nowhere/at/all.txt python3 scripts/gate/sweep.py --literal >/dev/null 2>&1; echo $? )"
if [ "$status" = "2" ]; then
  pass "a missing private list is exit 2, never a clean pass"
else
  fail "a missing private list is exit 2" "expected exit 2, got $status"
fi
rm -rf "$dir"

# ---------------------------------------------------------------------------
# Round four, 7 September. Four ways past the gate that the pass two version
# did not close. Every one of these is a negative test: it must fail, and it
# must keep failing.

echo "H. contamination appended inside an exempt file"
# The content exclusions name four files whose whole job is to contain the
# thing the gate looks for. Exempting the path exempts whatever anyone later
# puts in it. The exemption has to be of the approved bytes, not the name.
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
printf '\nAppended later: a note about %s\n' "$CANARY" >> "$dir/tests/gate/canary.txt"
git -C "$dir" add -f tests/gate/canary.txt >/dev/null
status="$(gate_status "$dir" --staged)"
if [ "$status" = "1" ]; then
  pass "an exempt file with changed contents is scanned (exit 1)"
else
  fail "an exempt file with changed contents is scanned" "expected exit 1, got $status; the exemption is by path, so anything can hide in that file"
fi
rm -rf "$dir"

echo "I. contamination force-added under a path the scanner skips"
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
mkdir -p "$dir/node_modules/evil"
printf 'a note about %s\n' "$CANARY" > "$dir/node_modules/evil/notes.txt"
git -C "$dir" add -f node_modules/evil/notes.txt >/dev/null
status="$(gate_status "$dir" --staged)"
if [ "$status" = "1" ]; then
  pass "a force-added file under a skipped prefix is scanned (exit 1)"
else
  fail "a force-added file under a skipped prefix is scanned" "expected exit 1, got $status; deliberately committing under node_modules/ bypassed the content scan"
fi
rm -rf "$dir"

echo "J. contamination introduced only by a merge resolution"
# A value that exists on neither parent, created while resolving a conflict.
# `git diff-tree` prints nothing for a merge commit unless it is asked to
# traverse each parent, so this content is in the published history and in no
# diff the range scanner ever reads.
#
# Note which case this is. If an ordinary commit later touches that file, the
# pre-image side of *that* commit carries the bytes and the scanner already
# catches it. The hole is content introduced by a merge and left alone.
dir="$(new_repo)"
printf 'base\n' > "$dir/shared.txt"
git -C "$dir" add shared.txt >/dev/null && git -C "$dir" commit -qm "seed"
git -C "$dir" switch -q -c side
printf 'side\n' > "$dir/shared.txt"
git -C "$dir" commit -qam "feat: side"
git -C "$dir" switch -q main
printf 'main\n' > "$dir/shared.txt"
git -C "$dir" commit -qam "feat: main"
git -C "$dir" merge side -q >/dev/null 2>&1
# Resolve with content that is on neither parent.
printf 'resolved with a note about %s\n' "$CANARY" > "$dir/shared.txt"
git -C "$dir" add shared.txt >/dev/null
git -C "$dir" commit -q --no-edit
status="$(gate_status "$dir" --range)"
if [ "$status" = "1" ]; then
  pass "merge-only content is scanned (exit 1)"
else
  fail "merge-only content is scanned" "expected exit 1, got $status; a value created while resolving a merge appears in no diff the range scanner reads"
fi
rm -rf "$dir"

echo "K. gitleaks exclusions are anchored"
# The allowlist entries are regexes matched against the whole path. An
# unanchored LICENSE also matches src/LICENSE-private-config.json, which is a
# perfectly good place to hide a credential.
unanchored="$(
  awk '/^paths = \[/{inside=1; next} inside && /^\]/{inside=0} inside' "$REPO_ROOT/.gitleaks.toml" \
    | tr -d "'" \
    | sed -E 's/^[[:space:]]*//; s/,[[:space:]]*$//' \
    | grep -v '^[[:space:]]*$' \
    | grep -vE '^\^.*\$$' || true
)"
if [ -z "$unanchored" ]; then
  pass "every gitleaks path exclusion is anchored"
else
  fail "every gitleaks path exclusion is anchored" "unanchored: $(printf '%s' "$unanchored" | tr '\n' ' ')"
fi

echo
echo "L. the secret scan reads what can be committed, and nothing else"
# Its cases build their own throwaway repositories, so they live in their own
# file; the counters here take its verdict. Wired in rather than given a step
# of its own because this is where the gitleaks configuration is already
# tested: case K above is the anchoring of the very allowlist the scan reads.
if secrets_out="$(bash "$REPO_ROOT/tests/gate/secrets-scan-cases.sh" 2>&1)"; then
  printf '%s\n' "$secrets_out" | grep -E '^  (PASS|FAIL) ' || true
  pass "the secret scan's file list holds (tests/gate/secrets-scan-cases.sh)"
else
  printf '%s\n' "$secrets_out" | grep -E '^  (PASS|FAIL) ' || true
  fail "the secret scan's file list holds (tests/gate/secrets-scan-cases.sh)" \
    "$(printf '%s' "$secrets_out" | tail -3 | tr '\n' ' ')"
fi

echo
echo "gate cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
