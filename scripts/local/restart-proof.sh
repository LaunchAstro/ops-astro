#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The W06 restart proof as one named run, at whatever head is checked out.
#
#   pnpm verify:restart [--name NAME] [--port PORT] [--api-port PORT] [--evidence FILE]
#
# It creates a disposable Postgres of its own, migrates it at this head, runs
# tests/acceptance/restart-and-expiry.test.ts with both restarts asked -- the
# container restarted under the suite, and apps/api/server.ts started, stopped
# and started again as a real process -- writes the evidence to FILE, and
# removes the container and stops any API process it started whether the run
# passed or failed. L5_RESTART_INDUCE_FAILURE=throw|crash, passed through to the
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
IMAGE=postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
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

created=no
PIDFILE=
cleanup() {
  status=$?
  # The API processes the run started, by the pids it wrote down. A runner that
  # died mid-case never reached its own afterAll, so they are stopped here.
  if [ -n "$PIDFILE" ] && [ -f "$PIDFILE" ]; then
    while read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        say "stopped api pid $pid"
        printf 'api stopped by trap: %s\n' "$pid" >>"$EVIDENCE"
      fi
    done <"$PIDFILE"
    sleep 1
    while read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done <"$PIDFILE"
    rm -f "$PIDFILE"
  fi
  if nc -z 127.0.0.1 "$API_PORT" 2>/dev/null; then
    printf 'api port still answering: %s\n' "$API_PORT" >>"$EVIDENCE"
    [ "$status" -ne 0 ] || status=1
  else
    printf 'api port free: %s\n' "$API_PORT" >>"$EVIDENCE"
  fi
  if [ "$created" = yes ]; then
    "$DOCKER" rm -f -v "$NAME" >/dev/null 2>&1 || true
    say "removed $NAME"
    printf 'container removed: %s\n' "$NAME" >>"$EVIDENCE"
  fi
  printf 'exit: %s\n' "$status" >>"$EVIDENCE"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$(dirname "$EVIDENCE")"
PIDFILE=$EVIDENCE.pids
: >"$PIDFILE"
{
  printf 'head: %s\n' "$head_sha"
  printf 'started: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'postgres: %s on 127.0.0.1:%s, api 127.0.0.1:%s\n' "$NAME" "$PORT" "$API_PORT"
} >"$EVIDENCE"

say "starting $NAME on 127.0.0.1:$PORT from the pinned digest"
"$DOCKER" run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" \
  -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=$DATABASE" "$IMAGE" >/dev/null
created=yes

ready=no
for _ in $(seq 1 60); do
  if "$DOCKER" exec "$NAME" pg_isready -q -U postgres -d "$DATABASE" 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
[ "$ready" = yes ] || { say 'the server did not become ready'; exit 1; }

# The group role the migrations grant to, then the migrations at this head.
"$DOCKER" exec -e PGPASSWORD="$PASSWORD" "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres \
  -d "$DATABASE" -c 'create role ops_astro_app nologin'
admin_url="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/$DATABASE"
say "migrating $DATABASE at $head_sha"
DATABASE_ADMIN_URL=$admin_url node scripts/db-migrate.mjs | tee -a "$EVIDENCE"

say 'running the restart proof'
DATABASE_URL=$admin_url DATABASE_ADMIN_URL=$admin_url \
  L5_RESTART_CONTAINER_NAME=$NAME L5_RESTART_API_PORT=$API_PORT L5_RESTART_EVIDENCE=$EVIDENCE \
  L5_RESTART_PIDFILE=$PIDFILE L5_RESTART_INDUCE_FAILURE=${L5_RESTART_INDUCE_FAILURE:-} \
  pnpm exec vitest run tests/acceptance/restart-and-expiry.test.ts tests/acceptance/restart-declared.test.ts \
  tests/acceptance/restart-http.test.ts \
  --fileParallelism=false --reporter=verbose 2>&1 | tee -a "$EVIDENCE"
say "evidence in $EVIDENCE"
