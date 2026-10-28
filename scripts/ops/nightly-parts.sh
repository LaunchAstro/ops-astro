#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# nightly-parts.sh: the suites tests/db/shard-plan.json splits into parts, run
# on main's head on the M5 every night (#2302); the fast gate skips them and
# pull requests run no full CI. deploy/m5/ops-astro-nightly-parts.plist starts
# it at 02:00; scripts/ops/README.md says what it does and how to install it.
# Exit 0 only when every suite passed.
# Usage: nightly-parts.sh [--list <repo> | --file-issue <suite> <log> <sha>]
set -uo pipefail

REPO=LaunchAstro/ops-astro
LABEL=nightly-parts
# The digest ci.yml's `database conformance` and the fast gate pin: postgres:17-alpine.
PG_IMAGE=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
CLONE=${NIGHTLY_CLONE:-$HOME/Desktop/Agents/repos/ops-astro/main}
LOGS=${NIGHTLY_LOGS:-$HOME/Library/Logs/ops-astro-nightly-parts}
SLOTS=$HOME/.oa-gate-slots
MAX_SLOTS=3 MAX_LOAD=${NIGHTLY_MAX_LOAD:-27}
SUITE_LIMIT=${NIGHTLY_SUITE_LIMIT:-14400}
# The bot login a standing schedule posts as; the plist names it, never the repo.
GH_USER=${NIGHTLY_GH_USER:-}

# The split suites, in the plan's order; a plan with none is refused, never a green night.
parts() {
  node -e '
    const parts = Object.keys(require(process.argv[1]).parts ?? {});
    if (parts.length === 0) { console.error("nightly-parts: the shard plan splits no suite"); process.exit(1); }
    console.log(parts.join("\n"));
  ' "$1/tests/db/shard-plan.json"
}

# file_issue <suite> <log> <sha>: one open issue per suite, by exact title.
file_issue() {
  local suite=$1 log=$2 sha=$3 title body token number
  title="nightly parts: $suite red on main"
  [ -n "$GH_USER" ] || { echo "nightly-parts: NIGHTLY_GH_USER is unset; $suite not reported" >&2; return 1; }
  token=$(gh auth token -h github.com -u "$GH_USER" 2>/dev/null) && [ -n "$token" ] \
    || { echo "nightly-parts: no gh login for $GH_USER; $suite not reported" >&2; return 1; }
  body=$(mktemp "${TMPDIR:-/tmp}/nightly-parts-body.XXXXXX")
  {
    echo "The nightly parts run (scripts/ops/nightly-parts.sh, #2302) on the M5 found \`$suite\` red on main at $sha, $(date '+%Y-%m-%d %H:%M %Z')."
    echo
    echo "Full log on the M5: \`${LOG:-$log}\`. Its last lines:"
    echo
    echo '~~~~text'
    tail -80 "$log"
    echo '~~~~'
  } >"$body"
  GH_TOKEN=$token gh label create "$LABEL" -R "$REPO" --force --color B60205 \
    --description 'A suite the nightly parts run on the M5 found red (#2302)' >/dev/null || true
  number=$(GH_TOKEN=$token gh issue list -R "$REPO" --label "$LABEL" --state open --limit 200 --json number,title \
    | node -e '
      let text = ""; process.stdin.on("data", (c) => (text += c)).on("end", () => {
        const hit = JSON.parse(text || "[]").find((i) => i.title === process.argv[1]);
        if (hit) console.log(hit.number);
      });' "$title") || { rm -f "$body"; return 1; }
  if [ -n "$number" ]; then
    GH_TOKEN=$token gh issue comment "$number" -R "$REPO" --body-file "$body" >/dev/null; local rc=$?
    echo "nightly-parts: $suite red; commented on #$number"
  else
    GH_TOKEN=$token gh issue create -R "$REPO" --title "$title" --label "$LABEL" --body-file "$body"; local rc=$?
    echo "nightly-parts: $suite red; opened the issue above"
  fi
  rm -f "$body"
  return $rc
}

usage() { echo "usage: nightly-parts.sh [--list <repo> | --file-issue <suite> <log> <sha>]" >&2; exit 2; }
case "${1:-}" in
  --list) [ $# -eq 2 ] || usage; parts "$2"; exit ;;
  --file-issue) [ $# -eq 4 ] || usage; file_issue "$2" "$3" "$4"; exit ;;
  '') ;;
  *) usage ;;
esac

mkdir -p "$LOGS"
LOG=$LOGS/$(date +%F).log
exec >>"$LOG" 2>&1
echo "== nightly-parts $(date '+%F %T %Z') pid $$"

SLOT="" WT="" CID="" RUNNING="" SCRATCH=""
end_group() {
  kill -TERM -"$1" 2>/dev/null || return 0
  for _ in $(seq 1 10); do kill -0 -"$1" 2>/dev/null || return 0; sleep 1; done
  kill -KILL -"$1" 2>/dev/null
  return 0
}
drop_db() { [ -n "$CID" ] && docker rm -f -v "$CID" >/dev/null 2>&1; CID=""; }
cleanup() {
  [ -n "$RUNNING" ] && end_group "$RUNNING"
  drop_db
  [ -n "$WT" ] && { git -C "$CLONE" worktree remove --force "$WT" >/dev/null 2>&1; git -C "$CLONE" worktree prune >/dev/null 2>&1; }
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
  [ -n "$SLOT" ] && rm -rf "$SLOT"
  echo "== nightly-parts end $(date '+%F %T %Z')"
}
trap cleanup EXIT; trap 'exit 130' INT TERM HUP

# A run that cannot start is reported too, as the suite "setup".
setup_failed() {
  echo "nightly-parts: setup failed: $1"
  tail -80 "$LOG" >"$SCRATCH/setup.log"
  file_issue setup "$SCRATCH/setup.log" "${SHA:-unknown}"
  exit 2
}
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/nightly-parts.XXXXXX")

# The slot code of the round's m5-gate.sh: one slot, taken only under the load cap.
load() { sysctl -n vm.loadavg | awk '{print int($2)}'; }
mkdir -p "$SLOTS"
said=no
while :; do
  if [ "$(load)" -lt $MAX_LOAD ]; then
    for i in $(seq 1 $MAX_SLOTS); do
      s=$SLOTS/slot-$i
      # A slot whose holder is gone is free again: removed only under its reclaim lock, holder re-read there (S2324-1).
      if [ -d "$s" ] && ! kill -0 "$(cat "$s/pid" 2>/dev/null || echo 0)" 2>/dev/null && mkdir "$s.reclaim" 2>/dev/null; then kill -0 "$(cat "$s/pid" 2>/dev/null || echo 0)" 2>/dev/null || rm -rf "$s"; rmdir "$s.reclaim"; fi
      if mkdir "$s" 2>/dev/null; then echo $$ >"$s/pid"; SLOT=$s; break 2; fi
    done
  fi
  [ $said = yes ] || { echo "nightly-parts: waiting for a slot (load $(load), cap $MAX_SLOTS runs, load < $MAX_LOAD)"; said=yes; }
  sleep 30
done
echo "nightly-parts: slot ${SLOT##*/}, load $(load)"

git -C "$CLONE" fetch -q origin main || setup_failed "fetch of origin/main"
SHA=$(git -C "$CLONE" rev-parse origin/main) || setup_failed "no origin/main"
mkdir -p "$HOME/trials"
WT=$HOME/trials/nightly-parts-$(date +%Y%m%d-%H%M%S)
git -C "$CLONE" worktree add -q --detach "$WT" "$SHA" || setup_failed "worktree at $SHA"
cd "$WT" || setup_failed "cd $WT"
echo "nightly-parts: main $SHA"
nice -n 15 pnpm install --frozen-lockfile --prefer-offline >"$SCRATCH/install.log" 2>&1 \
  || { tail -40 "$SCRATCH/install.log"; setup_failed "pnpm install"; }
SUITES=$(parts "$WT") || setup_failed "the shard plan"

# fresh_db: a throwaway Postgres on a random local port; its password is masked out of the log.
fresh_db() {
  local ready=no port
  PW=$(LC_ALL=C od -An -tx1 -N12 /dev/urandom | tr -d ' \n')
  CID=$(docker run -d --label oa-nightly-parts=1 -p 127.0.0.1::5432 \
    -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=conformance "$PG_IMAGE") || return 1
  for _ in $(seq 1 60); do
    docker exec "$CID" pg_isready -q -h 127.0.0.1 -U postgres -d conformance 2>/dev/null && { ready=yes; break; }
    sleep 1
  done
  [ $ready = yes ] || return 1
  port=$(docker port "$CID" 5432/tcp | head -1 | sed 's/.*://')
  export DATABASE_URL="postgres://postgres:$PW@127.0.0.1:$port/conformance"
  export FIXTURE_PG_CONTAINER=$CID
}

# run_suite <suite> <log>: all its parts, in a process group the subshell leads,
# under SUITE_LIMIT seconds (124 past it); masked output to <log> and the night's log.
run_suite() {
  local suite=$1 out=$2 t0 rc
  printf '{"conformance":["%s"]}\n' "$suite" >"$SCRATCH/manifest.json"
  t0=$(date +%s)
  set -m
  ( nice -n 15 node scripts/db-conformance.mjs --manifest "$SCRATCH/manifest.json" 2>&1 \
    | sed -u "s/$PW/[masked]/g" | tee "$out" ) &
  RUNNING=$!
  set +m
  while kill -0 "$RUNNING" 2>/dev/null; do
    if [ $(( $(date +%s) - t0 )) -ge "$SUITE_LIMIT" ]; then
      end_group "$RUNNING"; wait "$RUNNING" 2>/dev/null; RUNNING=""
      echo "nightly-parts: $suite over the ${SUITE_LIMIT}s limit" | tee -a "$out"
      return 124
    fi
    sleep 5
  done
  wait "$RUNNING"; rc=$?
  RUNNING=""
  return $rc
}

RED=0
while read -r suite; do
  out=$SCRATCH/$(basename "$suite").log
  if ! fresh_db; then
    echo "nightly-parts: no Postgres for $suite"
    setup_failed "a Postgres for $suite"
  fi
  t0=$(date +%s)
  run_suite "$suite" "$out"; rc=$?
  drop_db
  if [ $rc -eq 0 ]; then
    echo "NIGHTLY-PART PASS $suite seconds=$(( $(date +%s) - t0 )) sha=$SHA"
  else
    RED=1
    echo "NIGHTLY-PART FAIL $suite seconds=$(( $(date +%s) - t0 )) exit=$rc sha=$SHA"
    file_issue "$suite" "$out" "$SHA" || echo "nightly-parts: could not report $suite"
  fi
done <<<"$SUITES"

echo "NIGHTLY-PARTS $([ $RED -eq 0 ] && echo PASS || echo FAIL) sha=$SHA"
exit $RED
