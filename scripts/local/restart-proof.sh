#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The W06 restart proof as one named run, at whatever head is checked out.
#
#   pnpm verify:restart [--name NAME] [--port PORT] [--api-port PORT] [--evidence FILE]
#                       [--suite FILE]... [--no-pull]
#
# It creates a disposable Postgres of its own, migrates it at this head, runs
# tests/acceptance/restart-and-expiry.test.ts with both restarts asked -- the
# container restarted under the suite, and apps/api/server.ts started, stopped
# and started again as a real process -- writes the evidence to FILE, and
# removes the container and ends every API or worker process the run started,
# whether the run passed or failed. `--suite`, once or more, runs those files
# instead (`runtime-proofs.sh` names T3d2's). `--no-pull` (the journey's) never
# pulls: an image not on this machine is refused, with the pull command.
#
# The container is held by the id `docker run` returned, never by its name;
# a run ended while `docker run` is in flight waits for it and removes the
# container by the id it wrote to its --cidfile. Each run keeps that file and
# the keeper's FIFO in a `mktemp -d` folder of its own, which the trap removes,
# so two runs sharing an evidence path never touch each other's.
# The suites run as one job with a process group of its own, whose first
# member, the keeper, waits on a FIFO only this script writes to. When the
# script exits, or dies, the FIFO reaches end of file and the keeper ends that
# group with SIGKILL, repeated until the group is empty (a worker parked with
# SIGSTOP never runs a SIGTERM handler). Nothing is ever signalled by a pid read from a file: the pid file
# the suites write is evidence only, since a pid may be another process's by
# the time the trap runs.
# L5_RESTART_INDUCE_FAILURE=throw|crash, passed through to the
# run, makes it fail once everything is up, which is how that removal is shown.
#
# It never adopts a container it did not create: an existing NAME, a port
# already answering, or a name or port belonging to the working slice, the
# datafix database or the Hub's supabase_* stack is refused before anything
# starts.

set -euo pipefail

NAME=ops-astro-restart-proof-pg
PORT=54398
API_PORT=8798
EVIDENCE=
SUITES=()
NO_PULL=no
IMAGE=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
PASSWORD=ops_astro_restart_proof
DATABASE=ops_astro_restart_proof
DOCKER=${DOCKER:-/usr/local/bin/docker}
DENIED_NAMES=' ops-astro-local-pg ops-astro-datafix-pg '
DENIED_PORTS=' 54390 54391 54392 54397 54399 5190 8790 '

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --api-port) API_PORT=$2; shift 2 ;;
    --evidence) EVIDENCE=$2; shift 2 ;;
    --suite) SUITES+=("$2"); shift 2 ;;
    --no-pull) NO_PULL=yes; shift ;;
    # A package manager may forward the separator itself.
    --) shift ;;
    *) echo "restart-proof: unknown argument $1" >&2; exit 2 ;;
  esac
done

say() { printf 'restart-proof: %s\n' "$1"; }
refuse() { say "refused: $1" >&2; exit 2; }

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
head_sha=$(git rev-parse HEAD)
EVIDENCE=${EVIDENCE:-.local/restart-proof/evidence-${head_sha:0:12}.txt}

case "$DENIED_NAMES" in *" $NAME "*) refuse "$NAME is another stack's container" ;; esac
case "$NAME" in supabase_*) refuse "$NAME is a supabase_* container" ;; esac
for port in "$PORT" "$API_PORT"; do
  case "$DENIED_PORTS" in *" $port "*) refuse "port $port belongs to another stack" ;; esac
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then refuse "127.0.0.1:$port is already in use"; fi
done
if "$DOCKER" inspect "$NAME" >/dev/null 2>&1; then
  refuse "a container named $NAME already exists and this run only removes what it created"
fi
pull=missing
if [ "$NO_PULL" = yes ]; then
  pull=never
  "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 ||
    refuse "$IMAGE is not on this machine and --no-pull never pulls; pull it with: $DOCKER pull $IMAGE"
fi

cid=
launch=
job=
PIDFILE=
run_dir=
cleanup() {
  status=$?
  # Closing fd 4 lets the keeper end the suites' group. A runner that died
  # mid-case never reached its own afterAll, so its API and worker end here.
  if [ -n "${job:-}" ]; then
    exec 4>&-
    wait "$job" 2>/dev/null || true
    for _ in $(seq 1 50); do
      ps -A -o pgid= | grep -qx " *$job" || break
      sleep 0.1
    done
    if ps -A -o pgid= | grep -qx " *$job"; then
      printf 'process group still running: %s\n' "$job" >>"$EVIDENCE"
      status=1
    else
      printf 'process group ended: %s\n' "$job" >>"$EVIDENCE"
    fi
  fi
  if nc -z 127.0.0.1 "$API_PORT" 2>/dev/null; then
    printf 'api port still answering: %s\n' "$API_PORT" >>"$EVIDENCE"
    [ "$status" -ne 0 ] || status=1
  else
    printf 'api port free: %s\n' "$API_PORT" >>"$EVIDENCE"
  fi
  # Ended while `docker run` was in flight: let it finish, then take the id it wrote.
  if [ -z "${cid:-}" ] && [ -n "${run_dir:-}" ]; then
    [ -z "${launch:-}" ] || wait "$launch" 2>/dev/null || true
    cid=$(cat "$run_dir/cid" 2>/dev/null || true)
  fi
  if [ -n "${cid:-}" ]; then
    "$DOCKER" rm -f -v "$cid" >/dev/null 2>&1 || true
    say "removed $NAME ($cid)"
    printf 'container removed: %s %s\n' "$NAME" "$cid" >>"$EVIDENCE"
  fi
  [ -z "${run_dir:-}" ] || rm -rf "$run_dir"
  printf 'exit: %s\n' "$status" >>"$EVIDENCE"
  exit "$status"
}
trap cleanup EXIT
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/restart-proof.XXXXXX")

mkdir -p "$(dirname "$EVIDENCE")"
PIDFILE=$EVIDENCE.pids
: >"$PIDFILE"
{
  printf 'head: %s\n' "$head_sha"
  printf 'started: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'postgres: %s on 127.0.0.1:%s, api 127.0.0.1:%s\n' "$NAME" "$PORT" "$API_PORT"
} >"$EVIDENCE"

say "starting $NAME on 127.0.0.1:$PORT from the pinned digest"
# In the background, so that a trap reached mid-launch can wait for it.
"$DOCKER" run -d --cidfile "$run_dir/cid" --pull "$pull" --name "$NAME" -p "127.0.0.1:$PORT:5432" \
  -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=$DATABASE" "$IMAGE" >"$run_dir/run.out" &
launch=$!
wait "$launch"
launch=
cid=$(cat "$run_dir/run.out")

ready=no
for _ in $(seq 1 60); do
  # Over TCP: a fresh volume's init server answers the socket before TCP is up.
  if "$DOCKER" exec "$cid" pg_isready -q -h 127.0.0.1 -U postgres -d "$DATABASE" 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
[ "$ready" = yes ] || { say 'the server did not become ready'; exit 1; }

# The migrations go to 127.0.0.1:$PORT, so that must be this run's container.
published=$("$DOCKER" port "$cid" 5432 2>/dev/null || true)
[ "$published" = "127.0.0.1:$PORT" ] ||
  { say "$cid publishes ${published:-nothing}, not 127.0.0.1:$PORT"; exit 1; }

# The group role the migrations grant to, then the migrations at this head.
"$DOCKER" exec -e PGPASSWORD="$PASSWORD" "$cid" psql -v ON_ERROR_STOP=1 -q -U postgres \
  -d "$DATABASE" -c 'create role ops_astro_app nologin'
admin_url="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/$DATABASE"
say "migrating $DATABASE at $head_sha"
DATABASE_ADMIN_URL=$admin_url node scripts/db-migrate.mjs | tee -a "$EVIDENCE"

if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(tests/acceptance/restart-and-expiry.test.ts tests/acceptance/restart-declared.test.ts
    tests/acceptance/restart-http.test.ts)
fi
say "running ${SUITES[*]}"
fifo=$run_dir/keeper
mkfifo "$fifo"
# Read and write, so this open never blocks. The job's inherited copy is a
# writer until the job has opened the read end, so a death of this script at
# any point after the fork still leaves the keeper an end of file.
exec 4<>"$fifo"
set -m
(
  # Test only: a pause between the fork and the keeper's arming.
  if [ -n "${L5_RESTART_ARMING_PAUSE:-}" ]; then
    sh -c 'echo "$PPID"' >"$L5_RESTART_ARMING_PAUSE"
    sleep 1
  fi
  exec 3<"$fifo" 4>&-
  # The keeper. At end of file it starts, in a group of its own, a loop that
  # kills this group until it is empty: a process forked while one kill
  # lands can miss it.
  group=$(sh -c 'ps -o pgid= -p "$PPID"' | tr -d ' ')
  { read -r _ <&3 || true; set -m; { while kill -KILL -"$group" 2>/dev/null; do sleep 0.1; done; } & } &
  exec 3<&-
  DATABASE_URL=$admin_url DATABASE_ADMIN_URL=$admin_url \
    L5_RESTART_CONTAINER_NAME=$NAME L5_RESTART_API_PORT=$API_PORT L5_RESTART_EVIDENCE=$EVIDENCE \
    L5_RESTART_PIDFILE=$PIDFILE L5_RESTART_INDUCE_FAILURE=${L5_RESTART_INDUCE_FAILURE:-} \
    L5_RUNTIME_PROOFS=${L5_RUNTIME_PROOFS:-} \
    pnpm exec vitest run "${SUITES[@]}" --fileParallelism=false --reporter=verbose 2>&1 | tee -a "$EVIDENCE"
) </dev/null &
job=$!
set +m
printf 'process group: %s\n' "$job" >>"$EVIDENCE"
wait "$job"
say "evidence in $EVIDENCE"
