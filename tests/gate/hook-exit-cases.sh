#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The pre-push hook's exit-code policy, tested under the shell Husky uses.
#
# Husky runs a hook as `sh -e "$hook"` (.husky/_/h). Under `sh -e` a command
# that returns non-zero ends the script immediately, so a hook that runs the
# scanner and then reads $? never reaches its own handling. The scanner's
# exit 2, which means "the private list is not on this machine", killed the
# hook instead of being handled by it. That was finding 9 of the sweep.
#
# Each case substitutes a stub scanner whose exit code can be set per stage,
# runs the real hook the way Husky does, and asserts what the hook does.
#
# Usage: tests/gate/hook-exit-cases.sh [path-to-hook]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="${1:-$REPO_ROOT/.husky/pre-push}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

# Every case folder lives under one scratch folder, removed however the run
# ends, so an interrupted or failing run leaves nothing in the temp folder.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/hook-exit-cases.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# selftest_code range_code literal_code -> hook output plus HOOK_EXIT=n
run_hook_with() {
  local dir
  dir="$(mktemp -d "$SCRATCH/case.XXXXXX")"
  cat > "$dir/gate-stub" <<STUB
#!/bin/sh
mode="\$1"
echo "stub gate: \$mode"
case "\$mode" in
  --self-test) exit ${1} ;;
  --range)     exit ${2} ;;
  --literal)   exit ${3} ;;
  --repo)      exit ${4:-0} ;;
  *)           exit 0 ;;
esac
STUB
  chmod +x "$dir/gate-stub"
  (
    cd "$REPO_ROOT" || exit 99
    HUB_GATE_CMD="$dir/gate-stub" HUB_PUBLIC_CONTENT_CMD="$dir/gate-stub" sh -e "$HOOK" origin git@example.invalid:none.git </dev/null 2>&1
    echo "HOOK_EXIT=$?"
  )
  rm -rf "$dir"
}

echo "hook exit cases, against $HOOK"
echo

check() {
  local st="$1" rg="$2" lt="$3" expect="$4" must_say="$5" label="$6"
  local out actual
  out="$(run_hook_with "$st" "$rg" "$lt" "${7:-0}")"
  actual="$(printf '%s\n' "$out" | grep '^HOOK_EXIT=' | tail -1)"
  actual="${actual#HOOK_EXIT=}"
  if [ "$actual" != "$expect" ]; then
    fail "$label" "expected hook exit $expect, got ${actual:-none}. Output: $(printf '%s' "$out" | tr '\n' ' ')"
    return
  fi
  if [ -n "$must_say" ] && ! printf '%s' "$out" | grep -qi -- "$must_say"; then
    fail "$label" "hook exited $expect but never said '$must_say'. Output: $(printf '%s' "$out" | tr '\n' ' ')"
    return
  fi
  pass "$label"
}

#     self range lit  exit  must say          label
check 0 0 0        0  ""                 "all clean: the push proceeds"
check 0 0 1        1  "contamination"    "literal 1, a hit: refused, and says why"
check 0 0 2        0  "did not run"      "literal 2, no private list: proceeds, and says the sweep did not run"
check 0 0 3        1  "broken"           "literal 3, gate broken: refused, and says the gate is broken"
check 0 1 0        1  "contamination"    "range 1, a hit in the outgoing commits: refused"
check 0 3 0        1  "broken"           "range 3, gate broken: refused"
check 1 0 0        1  "self-test"        "self-test 1: refused before anything is scanned"
check 2 0 0        1  "self-test"        "self-test 2: refused; only the literal sweep may exit 2"
check 0 0 0        1  "public-content"   "public policy 1: refuses a history finding" 1
check 0 0 0        1  "public-content"   "public policy 2: no literal exception applies" 2
check 0 0 0        1  "public-content"   "public policy 3: refuses a scanner failure" 3

# The refs being pushed come in on stdin. Scanning every local branch instead
# would refuse a clean push because some unrelated local branch is dirty, and
# would say nothing about the branch actually being published. A backup branch
# kept before a history rewrite is the obvious case.
# Two throwaway repositories for the first-push cases, so the answer does not
# depend on whether the checkout running the cases has an origin/main.
make_repo() {
  git init -q "$1"
  git -C "$1" -c user.name=gate -c user.email=gate@example.invalid -c commit.gpgsign=false \
    commit -q --allow-empty -m base
}
NO_MAIN="$SCRATCH/no-main"
WITH_MAIN="$SCRATCH/with-main"
make_repo "$NO_MAIN"
make_repo "$WITH_MAIN"
git -C "$WITH_MAIN" update-ref refs/remotes/origin/main HEAD
MAIN_SHA="$(git -C "$WITH_MAIN" rev-parse HEAD)"
# A first push to GitHub asks GitHub for its main. HUB_PUBLISHED_URL stands a
# bare repository in for GitHub, so no case reaches the network.
GITHUB_URL=https://github.com/LaunchAstro/ops-astro.git
WITH_MAIN_URL="$SCRATCH/with-main.git"
git init -q --bare "$WITH_MAIN_URL"
git -C "$WITH_MAIN" push -q "$WITH_MAIN_URL" HEAD:refs/heads/main

# label stdin-line expected-text [repo] [push-url]
stdin_case() {
  local label="$1" line="$2" expect_scan="$3" repo="${4:-$REPO_ROOT}"
  local url="${5:-git@example.invalid:none.git}"
  local dir out
  dir="$(mktemp -d "$SCRATCH/case.XXXXXX")"
  cat > "$dir/gate-stub" <<'STUB'
#!/bin/sh
echo "stub gate: $*"
exit 0
STUB
  chmod +x "$dir/gate-stub"
  out="$(
    cd "$repo" || exit 99
    printf '%s\n' "$line" | HUB_GATE_CMD="$dir/gate-stub" HUB_PUBLIC_CONTENT_CMD="$dir/gate-stub" \
      HUB_PUBLISHED_URL="$WITH_MAIN_URL" sh -e "$HOOK" origin "$url" 2>&1
  )"
  rm -rf "$dir"
  if printf '%s' "$out" | grep -q -- "$expect_scan"; then
    pass "$label"
  else
    fail "$label" "expected the hook to scan '$expect_scan'. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}

ZERO=0000000000000000000000000000000000000000
# A first push to GitHub scans only what GitHub's main does not already have.
# Anywhere else, everything reachable is scanned.
stdin_case "a first push to GitHub scans only the commits not already on its main" \
  "refs/heads/new aaaaaaa1 refs/heads/new $ZERO" \
  "publish: $MAIN_SHA..aaaaaaa1" "$WITH_MAIN" "$GITHUB_URL"
stdin_case "a first push elsewhere scans everything reachable" \
  "refs/heads/new aaaaaaa1 refs/heads/new $ZERO" \
  "publish: aaaaaaa1$" "$NO_MAIN"

# Issue #1210. The real public-content checker, not a stub: origin/main holds
# a private path, and only a push to GitHub, whose main already holds it, may
# skip it. Only the hashed gate is stubbed.
DIRTY="$SCRATCH/dirty"
git init -q "$DIRTY"
# Built at run time, so this file never holds the path the gate refuses.
printf '/%s/synthetic-person/Documents/private-note\n' Users > "$DIRTY/note.txt"
git -C "$DIRTY" add note.txt
git -C "$DIRTY" -c user.name=gate -c user.email=gate@example.invalid -c commit.gpgsign=false \
  commit -q -m note
git init -q --bare "$SCRATCH/private.git"
git init -q --bare "$SCRATCH/public.git"
git -C "$DIRTY" push -q "$SCRATCH/private.git" HEAD:refs/heads/main
git -C "$DIRTY" remote add origin "$SCRATCH/private.git"
git -C "$DIRTY" remote add secondary "$SCRATCH/public.git"
git -C "$DIRTY" update-ref refs/remotes/origin/main HEAD
DIRTY_SHA="$(git -C "$DIRTY" rev-parse HEAD)"

# label remote url expected-exit [stand-in for GitHub]
real_checker_case() {
  local label="$1" out actual
  out="$(
    cd "$DIRTY" || exit 99
    printf 'refs/heads/main %s refs/heads/main %s\n' "$DIRTY_SHA" "$ZERO" \
      | HUB_GATE_CMD=true HUB_PUBLIC_CONTENT_CMD="node $REPO_ROOT/scripts/public-content-check.mjs" \
        HUB_PUBLISHED_URL="${5:-$SCRATCH/public.git}" sh -e "$HOOK" "$2" "$3" 2>&1
    echo "HOOK_EXIT=$?"
  )"
  actual="$(printf '%s\n' "$out" | grep '^HOOK_EXIT=' | tail -1)"
  if [ "${actual#HOOK_EXIT=}" = "$4" ]; then
    pass "$label"
  else
    fail "$label" "expected hook exit $4. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}
real_checker_case "a first push to another remote scans what origin/main holds" \
  secondary "$SCRATCH/public.git" 1
real_checker_case "a first push to a bare URL scans what origin/main holds" \
  "$SCRATCH/public.git" "$SCRATCH/public.git" 1
real_checker_case "a first push to origin by another push URL scans what origin/main holds" \
  origin "$SCRATCH/public.git" 1
real_checker_case "a first push to origin at GitHub still skips what GitHub's main holds" \
  origin "ssh://git@${GITHUB_URL#https://}/" 0 "$SCRATCH/private.git"
real_checker_case "a first push to a URL that only starts like GitHub's scans everything" \
  origin https://github.com/LaunchAstro/ops-astro-fork.git 1 "$SCRATCH/private.git"
git -C "$DIRTY" config url."$SCRATCH/private.git".insteadOf "$SCRATCH/public.git"
real_checker_case "a first push to GitHub asks GitHub, whatever URL rewrites say" \
  origin "$GITHUB_URL" 1
git -C "$DIRTY" config --unset url."$SCRATCH/private.git".insteadOf

# Sol's proofs on #1212, kept byte for byte. A remote whose URL changed keeps
# the old repository's tracking refs, which say nothing about the new one; a
# rewritten push URL, or a relative one that names a remote, asked again,
# can lead to another repository.
sol_proof_case() {
  if SOL_REVIEW_HOOK="$HOOK" node --test "$REPO_ROOT/tests/gate/$1.proof.test.mjs" >/dev/null 2>&1; then
    pass "$2"
  else
    fail "$2" "node --test tests/gate/$1.proof.test.mjs failed"
  fi
}
sol_proof_case sol-criterion-2-remote-url \
  "a first push after a remote's URL changes scans what its old main held"
sol_proof_case sol-criterion-2-double-url-rewrite \
  "a first push through a URL rewrite scans everything reachable"
sol_proof_case sol-criterion-2-url-remote-name \
  "a first push to a relative URL that names another remote scans everything reachable"

stdin_case "a later push scans only what the remote does not have" \
  "refs/heads/main aaaaaaa2 refs/heads/main bbbbbbb1" \
  "publish: bbbbbbb1..aaaaaaa2"
stdin_case "a branch deletion scans nothing, and does not fall back" \
  "refs/heads/gone $ZERO refs/heads/gone bbbbbbb1" \
  "publishes no new commits"

# Round four, 7 September. The two scanners must be given the same
# revisions. The pass two hook passed the pushed refs to --range and gave
# --literal nothing, so the literal sweep fell back to every outgoing branch:
# a contaminated backup branch could block a clean push of main, and the two
# scanners could disagree about what was being published.
same_refs_case() {
  local label="$1" line="$2" repo="${3:-$REPO_ROOT}" url="${4:-git@example.invalid:none.git}"
  local dir out range_args literal_args public_args
  dir="$(mktemp -d "$SCRATCH/case.XXXXXX")"
  cat > "$dir/gate-stub" <<'STUB'
#!/bin/sh
echo "stub gate: $*"
exit 0
STUB
  chmod +x "$dir/gate-stub"
  out="$(
    cd "$repo" || exit 99
    printf '%s\n' "$line" | HUB_GATE_CMD="$dir/gate-stub" HUB_PUBLIC_CONTENT_CMD="$dir/gate-stub" \
      HUB_PUBLISHED_URL="$WITH_MAIN_URL" sh -e "$HOOK" origin "$url" 2>&1
  )"
  rm -rf "$dir"
  range_args="$(printf '%s\n' "$out" | grep '^stub gate: --range' | sed 's/^stub gate: --range//' | tr -s ' ')"
  literal_args="$(printf '%s\n' "$out" | grep '^stub gate: --literal' | sed 's/^stub gate: --literal//' | tr -s ' ')"
  public_args=" $(printf '%s\n' "$out" | grep '^stub gate: --repo' | sed 's/.* --range //' | tr '\n' ' ' | sed 's/ $//')"
  if [ -z "$literal_args" ] && [ -z "$range_args" ]; then
    fail "$label" "neither scanner ran. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  elif [ "$range_args" != "$public_args" ]; then
    fail "$label" "range got '$range_args', public-content got '$public_args'"
  elif [ "$range_args" = "$literal_args" ]; then
    pass "$label"
  else
    fail "$label" "range got '$range_args', literal got '$literal_args'"
  fi
}

ZERO2=0000000000000000000000000000000000000000
same_refs_case "all three scanners get the same refs on a first push" \
  "refs/heads/main aaaaaaa1 refs/heads/main $ZERO2" "$WITH_MAIN" "$GITHUB_URL"
same_refs_case "all three scanners get the same refs on a first push with no origin/main" \
  "refs/heads/main aaaaaaa1 refs/heads/main $ZERO2" "$NO_MAIN"
same_refs_case "all three scanners get the same refs on a later push" \
  "refs/heads/main aaaaaaa2 refs/heads/main bbbbbbb1"

# A deletion is not the same as no input. With nothing to publish, neither
# scanner should fall back to every outgoing branch.
deletion_case() {
  local dir out
  dir="$(mktemp -d "$SCRATCH/case.XXXXXX")"
  cat > "$dir/gate-stub" <<'STUB'
#!/bin/sh
echo "stub gate: $*"
exit 0
STUB
  chmod +x "$dir/gate-stub"
  out="$(
    cd "$REPO_ROOT" || exit 99
    printf 'refs/heads/gone %s refs/heads/gone bbbbbbb1\n' "$ZERO2" \
      | HUB_GATE_CMD="$dir/gate-stub" HUB_PUBLIC_CONTENT_CMD="$dir/gate-stub" sh -e "$HOOK" origin git@example.invalid:none.git 2>&1
  )"
  rm -rf "$dir"
  if printf '%s' "$out" | grep -qE '^stub gate: --(range|literal)$'; then
    fail "a deletion does not fall back to every branch" "a bare --range or --literal ran, which scans every outgoing branch. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  else
    pass "a deletion does not fall back to every branch"
  fi
}
deletion_case

echo
echo "hook exit cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
