#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The first thing a fresh session runs.
#
# Finding 6 of the sweep of 6 September: nobody had shown that a fresh Claude
# Code or Codex session loads the intended router, resolves its skill
# references and applies the auto-memory policy. The scope boundary that keeps
# another project's instructions out of this one rested on asking the agent
# who it thought it was, which is not evidence.
#
# This prints what the session is actually working with, and fails if
# anything that must be present is missing. Run it before doing anything else.
#
#   bash scripts/agent-session-check.sh
#
# Exit 0 when the environment is what this repository expects, 1 when it is
# not. It reads; it changes nothing.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$(pwd)"

PROBLEMS=0
note()  { printf '  %-22s %s\n' "$1" "$2"; }
bad()   { printf '  PROBLEM  %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
warn()  { printf '  note     %s\n' "$1"; }

need_file() {
  if [ -f "$ROOT/$1" ]; then note "$2" "$1"; else bad "$1  ($2)"; fi
}

# --expect prints the facts a fresh session must be able to state back, so a
# person can compare what the session says it loaded against what is here.
# An agent is the least reliable witness to its own context: a Codex session
# on 7 September listed another project's pre-prompt among its loaded files
# and, in the next line, said it was not carrying another project's
# instructions. Both statements were sincere. Only one was checkable.
if [ "${1:-}" = "--expect" ]; then
  echo "Ask a fresh session these, and compare its answers with the right column."
  echo
  printf '  %-46s %s\n' "Which instruction files did you load?" "AGENTS.md at the repository root"
  printf '  %-46s %s\n' "Which router does this repository declare?" \
    "$(grep -m1 'loop routes the work' AGENTS.md 2>/dev/null || echo '(AGENTS.md missing)')"
  printf '  %-46s %s\n' "How many project skills can you invoke?" \
    "$(find .claude/skills -maxdepth 2 -name SKILL.md 2>/dev/null | xargs grep -L 'user-invocable: false' 2>/dev/null | wc -l | tr -d ' ') of $(find .claude/skills -maxdepth 1 -mindepth 1 -type d ! -name '_*' 2>/dev/null | wc -l | tr -d ' ') (the rest are principle leaves)"
  printf '  %-46s %s\n' "What does .claude/settings.json set?" \
    "$(tr -d ' \n' < .claude/settings.json 2>/dev/null)"
  printf '  %-46s %s\n' "How many merge questions are there?" \
    "$(grep -o 'on seven questions' AGENTS.md >/dev/null 2>&1 && echo seven || echo '(not seven; check AGENTS.md)')"
  printf '  %-46s %s\n' "What may you never do without asking?" \
    "Spend, send outward, delete, or touch production"
  printf '  %-46s %s\n' "What may you do without asking?" \
    "Reversible work inside this repository, then present it"
  printf '  %-46s %s\n' "Which permission mode are you running in?" \
    "Whatever it is, you must be able to say. A session that cannot is not ready"
  printf '  %-46s %s\n' "Are you carrying another project's rules?" "No. If yes, stop and say so"
  printf '  %-46s %s\n' "Does anything tell you to push?" "No. Nothing here pushes without a human"
  echo
  echo "A session that cannot state these did not load them, whatever it says."
  exit 0
fi

echo "Session check"
echo

# --- where am I ------------------------------------------------------------
echo "Repository"
if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  bad "this is not a git repository"
else
  note "path" "$ROOT"
  note "branch" "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  note "head" "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
  remotes="$(git -C "$ROOT" remote 2>/dev/null | tr '\n' ' ')"
  note "remotes" "${remotes:-none yet}"
  note "signing" "$(git -C "$ROOT" config commit.gpgsign 2>/dev/null || echo 'not set')"
fi
echo

# --- what am I meant to have read -----------------------------------------
echo "Instructions"
need_file "AGENTS.md" "the law"
need_file "CONTEXT.md" "the vocabulary"
need_file "docs/agents/model-roles.md" "roles, fresh context, handoff"
need_file "docs/agents/review-checkpoint.md" "when a review is valid"
need_file "docs/agents/session-check.md" "this procedure"
need_file "docs/agents/issue-tracker.md" "the tracker"
if [ -f "$ROOT/AGENTS.md" ]; then
  words=$(wc -w < "$ROOT/AGENTS.md" | tr -d ' ')
  if [ "$words" -le 300 ]; then
    note "AGENTS.md length" "$words words, under the 300 cap"
  else
    bad "AGENTS.md is $words words, over the 300 cap"
  fi
fi
echo

# --- what each runtime will actually load ----------------------------------
#
# File existence is not the question. The question is what reaches the model
# before it reads anything, and that is decided outside this repository, by
# each runtime's own configuration. Round four was right that checking for
# files proves nothing about the loaded context, so this section reports the
# configuration that decides it, and --expect prints the ground truth a fresh
# session must be able to state back.
echo "What each runtime loads"
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
note "claude config dir" "$claude_dir"
if [ -f "$ROOT/CLAUDE.md" ]; then
  note "claude entry" "CLAUDE.md, then AGENTS.md through it"
else
  note "claude entry" "AGENTS.md, read natively; no CLAUDE.md needed"
fi
if [ -f "$claude_dir/settings.json" ] && grep -q '"SessionStart"' "$claude_dir/settings.json" 2>/dev/null; then
  warn "this Claude seat has a SessionStart hook; check it does not match this directory"
else
  note "claude session hook" "none in this seat"
fi
if [ -f "$claude_dir/CLAUDE.md" ]; then
  bad "$claude_dir/CLAUDE.md applies to every session in this seat. Read it before"
  printf '           trusting anything this session says about its own instructions.\n'
else
  note "claude user law" "none, so AGENTS.md is the whole law here"
fi
note "codex entry" "AGENTS.md, plus \$HOME/.codex/AGENTS.md if it exists"
echo

# --- the router ------------------------------------------------------------
echo "Router"
if grep -q "No other routing block applies" "$ROOT/AGENTS.md" 2>/dev/null; then
  note "router" "$(grep -m1 'loop routes the work' "$ROOT/AGENTS.md")"
  note "exclusivity" "AGENTS.md says no other routing block applies"
else
  bad "AGENTS.md does not declare an exclusive router"
fi
echo

# --- another project's instructions ---------------------------------------
echo "Scope"
# A path check, not a word search. The decision records cite the other
# project's session notes as sources, and a citation is not an instruction:
# Current decisions distinguish references from loaded instructions. No
# pre-prompt or an overlay file, which would be instructions.
foreign="$(git -C "$ROOT" ls-files | grep -Ei '(pre-?prompt|overlay -|\.lanes\.md|HANDOFF\.md)' || true)"
if [ -n "$foreign" ]; then
  bad "instruction files from another project are in this tree:"
  printf '           %s\n' $foreign
else
  note "foreign instructions" "no pre-prompt, overlay, lanes or handoff file"
fi
# The runtime's own configuration, which sits outside this repository and can
# hand a session another project's instructions before it ever reads AGENTS.md.
# This is not hypothetical: a fresh Codex session in a clean clone of this
# repository, in a temporary directory, reported that it was carrying another
# project's pre-prompt. A committed setting cannot govern a runtime whose
# configuration lives in the home directory, so the check reads it.
# A global instruction file is not wrong for mentioning another project. It
# is wrong for *applying* that project here. Round five made the distinction:
# the pass three check refused any mention, including Nathan's correctly
# scoped file, which would have taught people to ignore it.
#
# So: does it load foreign instructions, is that load conditional, and does
# the condition reach this directory?
codex_agents="${HUB_CODEX_GLOBAL:-$HOME/.codex/AGENTS.md}"
if [ ! -f "$codex_agents" ]; then
  note "codex global law" "no file at $codex_agents"
elif ! grep -qiE 'pre-?prompt|operating context|system prompt' "$codex_agents" 2>/dev/null; then
  note "codex global law" "no foreign load instruction in it"
else
  # It loads something from elsewhere. Is the load scoped at all?
  if ! grep -qiE 'if,? and only if|only if|only when|in every other directory|does not apply|imposes nothing' "$codex_agents" 2>/dev/null; then
    bad "codex global law: $codex_agents loads another project's instructions"
    printf '           in every directory. Scope it to that project'"'"'s folders, or move\n'
    printf '           the lines into those repositories, before building here.\n'
  else
    # Scoped. Now the only question that matters: does the scope reach here?
    paths_file="$(mktemp)"
    # Whole paths, not first segments: ~/Desktop alone would match this
    # repository and every other one under it.
    grep -oE '(~|\$HOME)?/[A-Za-z0-9._*-]+([ /][A-Za-z0-9._*-]+)*' "$codex_agents" 2>/dev/null \
      | sed 's#[[:space:]]*$##' | sort -u > "$paths_file"
    scoped_paths="$(wc -l < "$paths_file" | tr -d ' ')"
    applicable=""
    while IFS= read -r candidate; do
      [ -z "$candidate" ] && continue
      case "$candidate" in
        '~/'*) expanded="$HOME${candidate#\~}" ;;
        '$HOME/'*) expanded="$HOME${candidate#\$HOME}" ;;
        *) expanded="$candidate" ;;
      esac
      case "$ROOT" in
        $expanded|$expanded/*) applicable="$applicable|$candidate" ;;
      esac
    done < "$paths_file"
    rm -f "$paths_file"
    if [ "$scoped_paths" -eq 0 ]; then
      bad "codex global law: $codex_agents talks about scope but names no"
      printf '           folders, so nothing decides whether it applies here.\n'
    elif [ -n "$applicable" ]; then
      bad "codex global law: $codex_agents scopes a foreign load to folders that"
      printf '           include this one: %s\n' "$(printf '%s' "$applicable" | tr '|' ' ')"
    else
      note "codex global law" "scoped, and its scope does not reach this directory"
    fi
  fi
fi

echo
echo "  If your session was given a pre-prompt naming another project, another"
echo "  task store, lanes, seats or merge trains, stop and say so. It does not"
echo "  apply here. See docs/current-decisions.md."
echo

# --- memory ----------------------------------------------------------------
echo "Memory"
settings="$ROOT/.claude/settings.json"
if [ ! -f "$settings" ]; then
  bad ".claude/settings.json"
elif grep -q '"autoMemoryEnabled"[[:space:]]*:[[:space:]]*false' "$settings"; then
  note "auto memory" "off for Claude Code, by the committed setting"
else
  bad ".claude/settings.json does not disable auto memory"
fi

# Trusted project configuration can override user defaults. A file check
# proves the repository policy, not what this already-running session loaded.
codex_project="${HUB_CODEX_PROJECT:-$ROOT/.codex/config.toml}"
if python3 "$ROOT/scripts/codex-policy-check.py" "$codex_project"; then
  note "codex project policy" "memory generation and injection disabled in project configuration"
else
  bad "codex project policy: required memory-off values are missing or invalid"
fi
warn "codex effective state: UNVERIFIED. Confirm the new session's effective configuration."
echo "  Project configuration loads only for trusted projects; CLI overrides take precedence."
echo "  This read-only check does not change trust or prove the state of a running session."
echo "  What an agent needs to know lives in AGENTS.md, CONTEXT.md and"
echo "  docs/, where a person can read it and a pull request can change it."
echo

# --- skills ----------------------------------------------------------------
echo "Skills"
if [ -d "$ROOT/.claude/skills" ]; then
  count=$(find "$ROOT/.claude/skills" -maxdepth 1 -mindepth 1 -type d ! -name '_*' | wc -l | tr -d ' ')
  note "vendored" "$count skills in .claude/skills"
else
  bad ".claude/skills"
fi
if [ -L "$ROOT/.codex/skills" ]; then
  note "codex" ".codex/skills -> $(readlink "$ROOT/.codex/skills")"
else
  bad ".codex/skills symlink, so Codex reads the same files"
fi
need_file ".claude/skills/_shared/security-review.md" "security review on any runtime"
echo

# --- tools -----------------------------------------------------------------
echo "Tools"
for tool in git node python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    note "$tool" "$(command -v "$tool")"
  else
    bad "$tool is not on PATH"
  fi
done
if command -v gitleaks >/dev/null 2>&1; then
  note "gitleaks" "$(command -v gitleaks)"
else
  warn "gitleaks is not on PATH; the pre-commit hook will fail until it is"
fi
if [ -f "$ROOT/.nvmrc" ]; then
  note "node wanted" "$(cat "$ROOT/.nvmrc")"
  note "node here" "$(node --version 2>/dev/null || echo none)"
fi
echo

# --- verdict ---------------------------------------------------------------
if [ "$PROBLEMS" -eq 0 ]; then
  echo "Session check: repository policy checks passed; effective session state remains UNVERIFIED."
  exit 0
fi
echo "Session check: $PROBLEMS problem(s). This session is not ready."
echo "Do not start work. docs/agents/session-check.md says what each one means."
exit 1
