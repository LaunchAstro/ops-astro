#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Negative tests for the secret scan's file list (scripts/secrets-scan.mjs).
#
# The scan's whole claim is that it reads what can be committed and nothing
# else. Round nine, 23 September, got there by exempting `^\.local/.*$` in
# `.gitleaks.toml`, which is a different claim: it reads what can be committed
# unless the path starts with `.local/`, which a `git add -f` makes committable
# anyway. These cases hold the corrected behaviour still, in a throwaway git
# repository, with a generated key rather than a real one:
#
#   L  an ignored .local/scratch.env with a key is not scanned, and the run passes
#   M  the same file force-added is scanned, and the run is refused
#   N  a tracked file carrying a key is refused
#   O  an empty file list is refused rather than passed
#
# Usage:  tests/gate/secrets-scan-cases.sh
# Exit 0 when every case passes, 1 when any case fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="$REPO_ROOT/scripts/secrets-scan.mjs"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "harness: gitleaks is not on PATH; these cases cannot run" >&2
  exit 1
fi

# A throwaway repository carrying the scanner and the real configuration, so
# the cases test the rules this repository ships and not a copy of them.
new_repo() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/scripts"
  cp "$SCANNER" "$dir/scripts/secrets-scan.mjs"
  cp "$REPO_ROOT/.gitleaks.toml" "$dir/.gitleaks.toml"
  printf '.local/\n' > "$dir/.gitignore"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name "Secrets Test"
  git -C "$dir" config user.email "secrets-test@example.invalid"
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" add .gitignore .gitleaks.toml scripts/secrets-scan.mjs
  echo "$dir"
}

# A key that has never been a credential anywhere: 48 random hex characters in
# an assignment, which is the shape gitleaks' generic rule is looking for.
write_key() {
  printf 'SERVICE_TOKEN="%s"\n' "$(openssl rand -hex 24)" > "$1"
}

scan_status() {
  ( cd "$1" && node scripts/secrets-scan.mjs >"$1/scan.out" 2>&1; echo $? )
}

# L. Ignored runtime scratch is not read.
dir="$(new_repo)"
mkdir -p "$dir/.local"
write_key "$dir/.local/scratch.env"
status="$(scan_status "$dir")"
if [ "$status" -eq 0 ] && ! grep -q '\.local/scratch\.env' "$dir/scan.out"; then
  pass "an ignored .local/scratch.env is excluded and the scan passes"
else
  fail "an ignored .local/scratch.env is excluded and the scan passes" \
    "exit $status; output: $(tr '\n' ' ' < "$dir/scan.out")"
fi
rm -rf "$dir"

# M. The same file, force-added, is read. Gitignored is not never-tracked.
dir="$(new_repo)"
mkdir -p "$dir/.local"
write_key "$dir/.local/scratch.env"
git -C "$dir" add -f .local/scratch.env
status="$(scan_status "$dir")"
if [ "$status" -ne 0 ] && grep -q 'leak' "$dir/scan.out"; then
  pass "the same file force-added is refused"
else
  fail "the same file force-added is refused" \
    "exit $status; output: $(tr '\n' ' ' < "$dir/scan.out")"
fi
rm -rf "$dir"

# N. An ordinary tracked file carrying a key is refused.
dir="$(new_repo)"
write_key "$dir/config.ts"
git -C "$dir" add config.ts
status="$(scan_status "$dir")"
if [ "$status" -ne 0 ] && grep -q 'leak' "$dir/scan.out"; then
  pass "a tracked file carrying a key is refused"
else
  fail "a tracked file carrying a key is refused" \
    "exit $status; output: $(tr '\n' ' ' < "$dir/scan.out")"
fi
rm -rf "$dir"

# O. A list of nothing is a scanner that has stopped scanning.
dir="$(mktemp -d)"
git -C "$dir" init -q -b main
cp "$SCANNER" "$dir/secrets-scan.mjs"
cp "$REPO_ROOT/.gitleaks.toml" "$dir/.gitleaks.toml"
printf '*\n' > "$dir/.gitignore"
rm "$dir/.gitignore.bak" 2>/dev/null
status="$( cd "$dir" && node secrets-scan.mjs >"$dir/scan.out" 2>&1; echo $? )"
if [ "$status" -ne 0 ] && grep -q 'empty' "$dir/scan.out"; then
  pass "an empty file list is refused, not passed"
else
  fail "an empty file list is refused, not passed" \
    "exit $status; output: $(tr '\n' ' ' < "$dir/scan.out")"
fi
rm -rf "$dir"

echo
echo "secrets-scan cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
