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

# Every case folder lives under one scratch folder, removed however the run
# ends, so an interrupted or failing run leaves nothing in the temp folder.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gate-cases.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# A throwaway repository with the gate installed. Never the real one.
new_repo() {
  local dir
  dir="$(mktemp -d "$SCRATCH/case.XXXXXX")"
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

echo "N. a denied term in a file name, a commit message or an author name"
# Git publishes the names and the messages as surely as the blobs. Each of
# these commits carries harmless bytes, so only the text outside the blobs can
# refuse it, and the evidence must not print the term it found.
SLUG="$(printf '%s' "$CANARY" | tr '[:upper:] ' '[:lower:]-')"
TERMS="$SCRATCH/gate-terms-list"
printf '%s\nzod\n' "$CANARY" > "$TERMS"
outside_blob_case() {
  local label="$1" mode="$2" file="$3" message="$4" author="$5"
  local dir out status
  dir="$(new_repo)"
  printf 'harmless bytes\n' > "$dir/$file"
  git -C "$dir" add "$file" >/dev/null
  git -C "$dir" -c user.name="$author" commit -qm "$message"
  out="$(cd "$dir" && HUB_GATE_TERMS="$TERMS" python3 scripts/gate/sweep.py "$mode" HEAD 2>&1)"
  status=$?
  if [ "$status" != "1" ]; then
    fail "$label" "expected exit 1, got $status. Output: $(printf '%s' "$out" | tr '\n' ' ')"
  elif printf '%s' "$out" | grep -qiE "$SLUG|$CANARY|zod"; then
    fail "$label" "refused, but the evidence printed the term it found"
  else
    pass "$label"
  fi
  rm -rf "$dir"
}
outside_blob_case "a hashed term in a file name is refused, and withheld" \
  --range "$SLUG.txt" "add a note" "Gate Test"
outside_blob_case "a hashed term in a commit message is refused" \
  --range notes.txt "a note about $CANARY" "Gate Test"
outside_blob_case "a literal term in a file name is refused, and withheld" \
  --literal "$SLUG.txt" "add a note" "Gate Test"
outside_blob_case "a literal term in a commit message is refused" \
  --literal notes.txt "a note about $CANARY" "Gate Test"
outside_blob_case "a literal term in an author name is refused" \
  --literal notes.txt "add a note" "Zod"

echo "O. a clean local replacement for a contaminated blob"
# `git replace` changes what this clone reads for an object, not what a push
# sends: the original blob is published. The gate must judge that one.
dir="$(new_repo)"
printf 'harmless first commit\n' > "$dir/seed.txt"
git -C "$dir" add seed.txt >/dev/null && git -C "$dir" commit -qm "seed"
printf 'a note about %s\n' "$CANARY" > "$dir/leak.txt"
git -C "$dir" add leak.txt >/dev/null
clean="$(printf 'nothing to see\n' | git -C "$dir" hash-object -w --stdin)"
git -C "$dir" replace "$(git -C "$dir" rev-parse :leak.txt)" "$clean"
status="$(gate_status "$dir" --staged)"
if [ "$status" = "1" ]; then
  pass "a staged blob is judged by its original bytes (exit 1)"
else
  fail "a staged blob is judged by its original bytes" "expected exit 1, got $status; the gate read the local replacement"
fi
git -C "$dir" commit -qm "add"
status="$(gate_status "$dir" --range HEAD)"
if [ "$status" = "1" ]; then
  pass "a committed blob is judged by its original bytes (exit 1)"
else
  fail "a committed blob is judged by its original bytes" "expected exit 1, got $status; the gate read the local replacement"
fi
status="$( cd "$dir" && HUB_GATE_TERMS="$TERMS" python3 scripts/gate/sweep.py --literal HEAD >/dev/null 2>&1; echo $? )"
if [ "$status" = "1" ]; then
  pass "the literal sweep judges a blob by its original bytes (exit 1)"
else
  fail "the literal sweep judges a blob by its original bytes" "expected exit 1, got $status; the gate read the local replacement"
fi
rm -rf "$dir"

echo "P. a directory the path sweep cannot read"
if [ "$(id -u)" = "0" ]; then
  # Root reads a mode 000 directory, so the case cannot be made here.
  pass "an unreadable directory is not clean (not provable as root, skipped)"
else
  dir="$(new_repo)"
  mkdir -p "$dir/target/locked"
  printf 'harmless\n' > "$dir/target/ok.txt"
  printf 'a note about %s\n' "$CANARY" > "$dir/target/locked/notes.txt"
  chmod 000 "$dir/target/locked"
  status="$(gate_status "$dir" --path target)"
  chmod 755 "$dir/target/locked"
  if [ "$status" = "1" ]; then
    pass "an unreadable directory is not clean (exit 1)"
  else
    fail "an unreadable directory is not clean" "expected exit 1, got $status; a directory never read was reported clean"
  fi
  rm -rf "$dir"
fi

echo "Q. a path sweep given an absolute path judges it as the repository's"
dir="$(new_repo)"
mkdir -p "$dir/fixtures/clients"
printf 'neutral\n' > "$dir/fixtures/clients/note.txt"
for target in fixtures/clients "$dir/fixtures/clients"; do
  status="$(gate_status "$dir" --path "$target")"
  if [ "$status" = "1" ]; then
    pass "a client fixture path is denied, given as ${target%%/fixtures*}... (exit 1)"
  else
    fail "a client fixture path is denied, given as $target" "expected exit 1, got $status"
  fi
done
for target in tests/gate/canary.txt "$dir/tests/gate/canary.txt"; do
  status="$(gate_status "$dir" --path "$target")"
  if [ "$status" = "0" ]; then
    pass "the approved canary is exempt, given as ${target%%/tests*}... (exit 0)"
  else
    fail "the approved canary is exempt, given as $target" "expected exit 0, got $status"
  fi
done
rm -rf "$dir"

echo "R. the self-test proves literal mode's own answer to a missing list"
# A mutation control: the literal sweep is changed to pass when the private
# list is missing, and nothing else. The self-test must catch it.
dir="$(new_repo)"
if python3 - "$dir/scripts/gate/sweep.py" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
mode = text.index("def mode_literal")
at = text.index("\n        return 2\n", mode)
path.write_text(text[:at] + "\n        return 0\n" + text[at + len("\n        return 2\n"):])
PY
then
  literal="$( cd "$dir" && HUB_GATE_TERMS=/nowhere/at/all.txt python3 scripts/gate/sweep.py --literal >/dev/null 2>&1; echo $? )"
  status="$(gate_status "$dir" --self-test)"
  if [ "$literal" = "0" ] && [ "$status" = "1" ]; then
    pass "a literal sweep that passes a missing list fails the self-test"
  else
    fail "a literal sweep that passes a missing list fails the self-test" "the mutated literal sweep exited $literal; the self-test exited $status, expected 1"
  fi
else
  fail "a literal sweep that passes a missing list fails the self-test" "the mutation found no missing-list exit 2 in mode_literal"
fi
rm -rf "$dir"

echo "S. a denied folder at the repository root is denied in either path form"
# Path rules are written against repository-relative paths, so a rule for a
# folder anywhere must also hold when that folder sits at the root.
dir="$(new_repo)"
for folder in client-data os-mirror; do
  mkdir -p "$dir/$folder"
  printf 'neutral\n' > "$dir/$folder/note.txt"
  for target in "$folder" "$dir/$folder"; do
    status="$(gate_status "$dir" --path "$target")"
    if [ "$status" = "1" ]; then
      pass "a root $folder folder is denied, given as ${target%%/$folder}... (exit 1)"
    else
      fail "a root $folder folder is denied, given as $target" "expected exit 1, got $status"
    fi
  done
done
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
echo "M. the secret scan's cases plant only keys gitleaks detects"
# About one random 48-hex key in a hundred slips under gitleaks: entropy below
# the generic rule's 3.5, or a hex word such as "dead" on its stopword list.
# Planted in case M or N, that key turns a correct scanner red. An openssl
# that answers every other call with 48 zeros, which gitleaks never flags,
# makes that miss certain: the cases must regenerate past it, and fail loudly
# rather than plant it when no key is ever detected.
stub_bin="$(mktemp -d "$SCRATCH/stub.XXXXXX")"
cat > "$stub_bin/openssl" <<STUB
#!/usr/bin/env bash
calls=\$(( \$(cat "$stub_bin/calls" 2>/dev/null || echo 0) + 1 ))
echo "\$calls" > "$stub_bin/calls"
if [ "\$STUB_MODE" = always ] || [ \$((calls % 2)) -eq 1 ]; then printf '%048d\n' 0; exit 0; fi
exec "$(command -v openssl)" "\$@"
STUB
chmod +x "$stub_bin/openssl"
if STUB_MODE=alternate PATH="$stub_bin:$PATH" bash "$REPO_ROOT/tests/gate/secrets-scan-cases.sh" >/dev/null 2>&1; then
  pass "a key gitleaks misses is regenerated, not planted"
else
  fail "a key gitleaks misses is regenerated, not planted" \
    "with every other generated key undetectable, secrets-scan-cases.sh failed"
fi
rm -f "$stub_bin/calls"
never_out="$(STUB_MODE=always PATH="$stub_bin:$PATH" bash "$REPO_ROOT/tests/gate/secrets-scan-cases.sh" 2>&1)"
if [ $? -ne 0 ] && printf '%s' "$never_out" | grep -q '^harness: gitleaks detected none'; then
  pass "no detectable key after the bounded tries fails the harness loudly"
else
  fail "no detectable key after the bounded tries fails the harness loudly" \
    "$(printf '%s' "$never_out" | tail -3 | tr '\n' ' ')"
fi

if python3 "$REPO_ROOT/tests/gate/literal-history-cases.py" "$GATE_DIR"; then
  pass "exact historical literal decisions retain refusal boundaries"
else
  fail "exact historical literal decisions retain refusal boundaries" "synthetic literal controls failed"
fi

echo
echo "gate cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
