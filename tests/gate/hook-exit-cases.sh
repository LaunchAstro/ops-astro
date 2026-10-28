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
check 0 0 2        1  "HUB_GATE_TERMS"   "literal 2, no private list: refused, and names the setting"
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
# A throwaway repository with an origin/main for the first-push cases, so the
# answer does not depend on the checkout running the cases.
WITH_MAIN="$SCRATCH/with-main"
git init -q "$WITH_MAIN"
git -C "$WITH_MAIN" -c user.name=gate -c user.email=gate@example.invalid -c commit.gpgsign=false \
  commit -q --allow-empty -m base
git -C "$WITH_MAIN" update-ref refs/remotes/origin/main HEAD

# label stdin-line expected-text [repo]
stdin_case() {
  local label="$1" line="$2" expect_scan="$3" repo="${4:-$REPO_ROOT}"
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
    printf '%s\n' "$line" | HUB_GATE_CMD="$dir/gate-stub" HUB_PUBLIC_CONTENT_CMD="$dir/gate-stub" sh -e "$HOOK" origin git@example.invalid:none.git 2>&1
  )"
  rm -rf "$dir"
  if printf '%s' "$out" | grep -q -- "$expect_scan"; then
    pass "$label"
  else
    fail "$label" "expected the hook to scan '$expect_scan'. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}

ZERO=0000000000000000000000000000000000000000
# A first push scans everything reachable from the local ref. A local
# origin/main says nothing about what the destination holds (#1210).
stdin_case "a first push scans everything reachable, even with an origin/main" \
  "refs/heads/new aaaaaaa1 refs/heads/new $ZERO" \
  "publish: aaaaaaa1$" "$WITH_MAIN"

# The real public-content checker, not a stub: origin/main holds a private
# path, and every first push still reads it. Only the hashed gate is stubbed.
DIRTY="$SCRATCH/dirty"
git init -q "$DIRTY"
# Built at run time, so this file never holds the path the gate refuses.
printf '/%s/synthetic-person/Documents/private-note\n' Users > "$DIRTY/note.txt"
git -C "$DIRTY" add note.txt
git -C "$DIRTY" -c user.name=gate -c user.email=gate@example.invalid -c commit.gpgsign=false \
  commit -q -m note
git -C "$DIRTY" update-ref refs/remotes/origin/main HEAD
DIRTY_SHA="$(git -C "$DIRTY" rev-parse HEAD)"

# label remote url
real_checker_refuses() {
  local out actual
  out="$(
    cd "$DIRTY" || exit 99
    printf 'refs/heads/main %s refs/heads/main %s\n' "$DIRTY_SHA" "$ZERO" \
      | HUB_GATE_CMD=true HUB_PUBLIC_CONTENT_CMD="node $REPO_ROOT/scripts/public-content-check.mjs" \
        sh -e "$HOOK" "$2" "$3" 2>&1
    echo "HOOK_EXIT=$?"
  )"
  actual="$(printf '%s\n' "$out" | grep '^HOOK_EXIT=' | tail -1)"
  if [ "${actual#HOOK_EXIT=}" = 1 ]; then
    pass "$1"
  else
    fail "$1" "expected hook exit 1. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}
real_checker_refuses "a first push to another remote reads what origin/main holds" \
  secondary "$SCRATCH/public.git"
real_checker_refuses "a first push to a bare URL reads what origin/main holds" \
  "$SCRATCH/public.git" "$SCRATCH/public.git"
real_checker_refuses "a first push to origin on GitHub reads what origin/main holds" \
  origin https://github.com/LaunchAstro/ops-astro.git

# The hook runs the pushed commit's checker from a temporary folder, which on
# macOS sits behind a symlink. A checker reached through a symlinked path must
# still check, not take itself for an import and exit 0 having read nothing.
ln -s "$REPO_ROOT/scripts" "$SCRATCH/linked-scripts"
if node "$SCRATCH/linked-scripts/public-content-check.mjs" --repo "$DIRTY" --range "$DIRTY_SHA" >/dev/null 2>&1; then
  fail "the checker reached through a symlinked folder still refuses" "it exited 0 on a private path"
else
  pass "the checker reached through a symlinked folder still refuses"
fi

# Proofs from #1212's review that a skipped first-push range publishes history
# the destination never received: a remote whose URL changed, a rewritten
# push URL, a relative URL that names another remote, and an SSH transport
# that reaches another receiver.
proof_case() {
  if SOL_REVIEW_HOOK="$HOOK" node --test "$REPO_ROOT/tests/gate/$1.test.mjs" >/dev/null 2>&1; then
    pass "$2"
  else
    fail "$2" "node --test tests/gate/$1.test.mjs failed"
  fi
}
proof_case pre-push-remote-url-change-scans-history \
  "a first push after a remote's URL changes scans everything reachable"
proof_case pre-push-double-url-rewrite-scans-history \
  "a first push through a URL rewrite scans everything reachable"
proof_case pre-push-relative-url-naming-remote-scans-history \
  "a first push to a relative URL that names another remote scans everything reachable"
proof_case pre-push-ssh-transport-scans-history \
  "a first push over an SSH transport to another receiver scans everything reachable"
proof_case pre-push-exports-published-scanners-not-replacements \
  "a pushed commit is judged by its published scanners, not a local replacement's"
proof_case pre-push-ignores-uncommitted-canary-bytes \
  "uncommitted canary bytes in the checkout cannot refuse a clean pushed commit"
proof_case pre-push-refuses-without-private-list \
  "a push without the private list is refused, and one with it runs the literal sweep"
proof_case pre-push-first-push-scans-unpassed-commits \
  "a first push scans the commits this machine's gate has not passed, and refuses a key in them"
proof_case pre-push-first-push-passed-record-covers-history \
  "a passed commit vouches for its history only under the scanners and rules that judged it"
proof_case pre-push-first-push-fingerprint-covers-scan-inputs \
  "a passed commit vouches for a later push only under the same scan inputs"
proof_case hooks-refuse-when-not-installed \
  "a checkout without installed hooks refuses to push, whatever commit it is on"
proof_case path-sweep-withholds-denied-name-in-all-evidence \
  "the path sweep withholds a denied file name in its summary as well"
proof_case pre-push-cleanup-keeps-files-beside-a-spaced-tmpdir \
  "the hook's cleanup keeps unrelated files when TMPDIR holds a space, and the scan still runs"
proof_case sweep-refuses-denied-messages-and-symlinked-paths \
  "a denied commit message under any display encoding, and a denied path through a symlinked folder, are refused"

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
  local label="$1" line="$2" repo="${3:-$REPO_ROOT}"
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
    printf '%s\n' "$line" | HUB_GATE_CMD="$dir/gate-stub" HUB_PUBLIC_CONTENT_CMD="$dir/gate-stub" sh -e "$HOOK" origin git@example.invalid:none.git 2>&1
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
  "refs/heads/main aaaaaaa1 refs/heads/main $ZERO2" "$WITH_MAIN"
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

# The rules that judge a push are the pushed commit's own, not whatever the
# checkout the push starts in has. A stale checkout must not refuse a clean
# push, nor pass what the pushed commit's scanners refuse, and a branch that
# changes a scanner is judged by its own version. No override is set here:
# the real hook finds the scanners itself. Each fixture scanner answers every
# mode with one exit code.
OWN="$SCRATCH/own-scanners"
git init -q "$OWN"
mkdir -p "$OWN/scripts/gate" "$OWN/tests/gate"
: > "$OWN/tests/gate/canary.txt"
scanners_exit() {
  printf 'import sys\nprint("fixture gate exits %s")\nsys.exit(%s)\n' "$1" "$1" \
    > "$OWN/scripts/gate/sweep.py"
  printf 'console.log("fixture public content exits %s");\nprocess.exit(%s);\n' "$1" "$1" \
    > "$OWN/scripts/public-content-check.mjs"
}

# label committed-exit working-tree-exit expected-hook-exit
own_scanner_case() {
  local out actual sha
  scanners_exit "$2"
  git -C "$OWN" add -A
  git -C "$OWN" -c user.name=gate -c user.email=gate@example.invalid -c commit.gpgsign=false \
    commit -q --allow-empty -m "scanners exit $2"
  sha="$(git -C "$OWN" rev-parse HEAD)"
  scanners_exit "$3"
  out="$(
    cd "$OWN" || exit 99
    printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$ZERO" \
      | env -u HUB_GATE_CMD -u HUB_PUBLIC_CONTENT_CMD sh -e "$HOOK" origin git@example.invalid:none.git 2>&1
    echo "HOOK_EXIT=$?"
  )"
  actual="$(printf '%s\n' "$out" | grep '^HOOK_EXIT=' | tail -1)"
  if [ "${actual#HOOK_EXIT=}" = "$4" ]; then
    pass "$1"
  else
    fail "$1" "expected hook exit $4. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}
own_scanner_case "a pushed commit whose own scanners pass gets through a checkout whose scanners refuse" 0 1 0
own_scanner_case "a pushed commit whose own scanners refuse is refused by a checkout whose scanners pass" 1 0 1

echo
echo "hook exit cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
