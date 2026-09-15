#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The session check's reading of a global instruction file.
#
# Round five: the pass three check rejected any global file that mentioned
# the other project at all, including a correctly scoped one. That is the
# wrong test. What matters is not whether a file mentions foreign
# instructions, but whether it applies them *here*.
#
# Each case writes a temporary fake global file and points the check at it.
# Nothing in a home directory is read or written.
#
# Usage: tests/agents/session-check-cases.sh [path-to-check]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="${1:-$REPO_ROOT/scripts/agent-session-check.sh}"

PASSED=0
FAILED=0
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# verdict <file-or-empty> -> the line the check prints about the global file
verdict() {
  local file="$1"
  ( cd "$REPO_ROOT" && HUB_CODEX_GLOBAL="$file" bash "$CHECK" 2>&1 | grep -iE 'codex global|global instruction' | head -1 )
}

# expect <label> <file> <ok|fail>
expect() {
  local label="$1" file="$2" want="$3" line
  line="$(verdict "$file")"
  if [ "$want" = "ok" ]; then
    if printf '%s' "$line" | grep -q 'PROBLEM'; then
      fail "$label" "the check rejected it: $line"
    elif [ -z "$line" ]; then
      fail "$label" "the check said nothing about the global file"
    else
      pass "$label"
    fi
  else
    if printf '%s' "$line" | grep -q 'PROBLEM'; then
      pass "$label"
    else
      fail "$label" "the check accepted it: ${line:-<nothing printed>}"
    fi
  fi
}

echo "session check cases, against $CHECK"
echo

# 1. No global file at all.
expect "no global instruction file is fine" "$TMP/absent.md" ok

# 2. The unconditional load. This is what the machine had before 7 September.
cat > "$TMP/unconditional.md" <<'EOF'
Load local operating context from:
`~/fixture-workspace/Skills & Automations/System Prompt/Fixture Pre-Prompt.md`
EOF
expect "an unconditional foreign load is refused" "$TMP/unconditional.md" fail

# 3. A scoped load that does not name this repository. This is the shape of
#    the file on this laptop after Nathan scoped it.
cat > "$TMP/scoped-elsewhere.md" <<'EOF'
Scope rule. If, and only if, the current working directory is inside one of
these folders:
- ~/fixture-workspace
- ~/projects/elsewhere, or any ~/projects/elsewhere-wt-* worktree
then load the local operating context from the Fixture Pre-Prompt.

In every other directory this file imposes nothing.
EOF
expect "a scoped load that excludes this repository is accepted" "$TMP/scoped-elsewhere.md" ok

# 4. A scope that reaches this repository. Conditional, and the condition is
#    true here, which is the case that must still fail.
cat > "$TMP/scoped-here.md" <<EOF
Scope rule. If, and only if, the current working directory is inside one of
these folders:
- ~/fixture-workspace
- "$REPO_ROOT"
then load the local operating context from the Fixture Pre-Prompt.

In every other directory this file imposes nothing.
EOF
expect "a scope that names this repository is refused" "$TMP/scoped-here.md" fail

# 5. A scope whose glob reaches this repository.
cat > "$TMP/scoped-glob.md" <<EOF
Scope rule. Only when the working directory is inside "$REPO_ROOT*"
should you load the Fixture Pre-Prompt. In every other directory this file
imposes nothing.
EOF
expect "a scope whose glob covers this repository is refused" "$TMP/scoped-glob.md" fail

# 6. Words about scoping with no folders named is not a scope.
cat > "$TMP/vague.md" <<'EOF'
Only when it is relevant, load the local operating context from the Fixture
Pre-Prompt. Use your judgement.
EOF
expect "a scope that names no folders is refused" "$TMP/vague.md" fail

# 7. A global file that has nothing to do with another project.
cat > "$TMP/harmless.md" <<'EOF'
Prefer ripgrep over grep. Keep replies short.
EOF
expect "a global file with no foreign load is fine" "$TMP/harmless.md" ok

# Project policy detection is independent of the user's global defaults.
cat > "$TMP/memory-off.toml" <<'EOF'
[features]
memories = false
[memories]
generate_memories = false
use_memories = false
EOF
cat > "$TMP/memory-on.toml" <<'EOF'
[features]
memories = false
[memories]
generate_memories = true
use_memories = false
EOF
cat > "$TMP/memory-malformed.toml" <<'EOF'
[features]
memories = false
memories = true
EOF
for candidate_policy in memory-off memory-on memory-malformed absent; do
  output="$(HUB_CODEX_GLOBAL="$TMP/harmless.md" HUB_CODEX_PROJECT="$TMP/$candidate_policy.toml" bash "$CHECK" 2>&1)"
  policy_line="$(printf '%s\n' "$output" | grep 'codex project policy')"
  if [ "$candidate_policy" = "memory-off" ]; then
    if printf '%s' "$policy_line" | grep -q 'PROBLEM'; then fail "valid project memory-off policy" "the policy was rejected"; else pass "valid project memory-off policy"; fi
  else
    if printf '%s' "$policy_line" | grep -q 'PROBLEM'; then pass "invalid or missing project policy is refused"; else fail "invalid or missing project policy is refused" "the policy was accepted"; fi
  fi
  if printf '%s\n' "$output" | grep -q 'codex effective state: UNVERIFIED'; then
    pass "effective running-session state stays unverified"
  else
    fail "effective running-session state stays unverified" "the evidence boundary was not reported"
  fi
done

echo
echo "session check cases: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
