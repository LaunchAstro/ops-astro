#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The working slice's own Postgres, started and made ready.
#
# It is a separate container on a loopback port of its own, and it is never the
# Hub's supabase_* database and never the draft's. The image is the digest
# pinned in docs/supply-chain-pins.md, not a tag, so the server a test ran
# against is the server the next run gets.
#
# Idempotent by design: running it twice is running it once. A container that
# is already up and correct is left alone, a stopped one is started, and one
# whose mount is wrong is replaced -- the container, never the named volume,
# which is where the data that has to survive a restart lives.
#
# Two roles, which is the point of the two URLs it writes:
#   DATABASE_ADMIN_URL  the owner. Migrations, the seed, and the test harness,
#                       which creates a throwaway database per run.
#   DATABASE_URL        the runtime role `app`, a member of the group role the
#                       migrations grant to. It owns nothing, may create
#                       nothing, and cannot bypass row security, so tenancy is
#                       held by the server rather than by good manners.

set -euo pipefail

CONTAINER=ops-astro-local-pg
VOLUME=ops-astro-local-pgdata
IMAGE=postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
HOST=127.0.0.1
PORT=54390
DATABASE=ops_astro_local
ADMIN_USER=postgres
ADMIN_PASSWORD=ops_astro_local
APP_USER=app
GROUP_ROLE=ops_astro_app

# Postgres 18 puts its data in a subdirectory of this path. Mounting the volume
# at /var/lib/postgresql/data instead is what makes 18 refuse to start, having
# found a cluster in a directory it does not use.
DATA_MOUNT=/var/lib/postgresql

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
env_file="$repo_root/.local/db.env"
mkdir -p "$repo_root/.local"

say() { printf 'db-up: %s\n' "$1"; }

docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null

state=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo absent)
if [ "$state" != absent ]; then
  mount_ok=$(docker inspect "$CONTAINER" \
    --format '{{range .Mounts}}{{if eq .Destination "'"$DATA_MOUNT"'"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)
  image_ok=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)
  if [ "$mount_ok" != "$VOLUME" ] || [ "$image_ok" != "$IMAGE" ]; then
    say "replacing $CONTAINER: it is on $image_ok with $DATA_MOUNT from '${mount_ok:-nothing}'"
    say "the named volume $VOLUME is kept; only the container is removed"
    docker rm -f "$CONTAINER" >/dev/null
    state=absent
  fi
fi

case "$state" in
  running) say "$CONTAINER is already running" ;;
  absent)
    say "starting $CONTAINER on $HOST:$PORT from the pinned digest"
    docker run -d \
      --name "$CONTAINER" \
      -p "$HOST:$PORT:5432" \
      -v "$VOLUME:$DATA_MOUNT" \
      -e "POSTGRES_PASSWORD=$ADMIN_PASSWORD" \
      -e "POSTGRES_DB=$DATABASE" \
      "$IMAGE" >/dev/null
    ;;
  *) say "starting the stopped $CONTAINER"; docker start "$CONTAINER" >/dev/null ;;
esac

say 'waiting for the server to accept connections'
for _ in $(seq 1 60); do
  # Over TCP: a fresh volume's init server answers the socket before TCP is up.
  if docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U "$ADMIN_USER" -d "$DATABASE" 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
if [ "${ready:-no}" != yes ]; then
  say "the server did not become ready; its log follows"
  docker logs --tail 40 "$CONTAINER"
  exit 1
fi

# The runtime password is generated once and then read back, so a second run
# does not invalidate the URL the API is already holding.
if [ -f "$env_file" ] && grep -q '^APP_PASSWORD=' "$env_file"; then
  APP_PASSWORD=$(grep '^APP_PASSWORD=' "$env_file" | head -1 | cut -d= -f2-)
else
  # 16 random bytes as hex. `od` reads exactly what it was asked for and stops,
  # so nothing in this pipeline is killed by a reader closing early -- which is
  # what `tr -dc < /dev/urandom | head` does, and under `set -o pipefail` that
  # is a failure rather than a password.
  APP_PASSWORD=$(LC_ALL=C od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
fi

# The group role is what the migrations grant to; the login role is a member of
# it and is how the application connects. Both are created only if absent, and
# the password is set every time so the file and the server cannot disagree.
docker exec -i -e PGPASSWORD="$ADMIN_PASSWORD" "$CONTAINER" \
  psql -v ON_ERROR_STOP=1 -q -U "$ADMIN_USER" -d "$DATABASE" <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$GROUP_ROLE') then
    create role $GROUP_ROLE nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = '$APP_USER') then
    create role $APP_USER login nosuperuser nocreatedb nocreaterole nobypassrls inherit;
  end if;
end \$\$;
alter role $APP_USER password '$APP_PASSWORD';
grant $GROUP_ROLE to $APP_USER;
grant connect on database $DATABASE to $APP_USER;
-- PostgreSQL grants TEMPORARY on a new database to PUBLIC. A temporary table
-- lives outside every schema the runtime role is refused CREATE in, and on a
-- pooled backend it outlives the transaction and shadows records for the
-- next tenant, so it is revoked here with the rest of what the role may not do.
revoke temporary on database $DATABASE from public;
SQL

admin_url="postgres://$ADMIN_USER:$ADMIN_PASSWORD@$HOST:$PORT/$DATABASE"
app_url="postgres://$APP_USER:$APP_PASSWORD@$HOST:$PORT/$DATABASE"

umask 077
cat > "$env_file" <<ENV
# Written by scripts/local/db-up.sh. Local only, gitignored, not a secret store.
DATABASE_URL=$app_url
DATABASE_ADMIN_URL=$admin_url
APP_PASSWORD=$APP_PASSWORD
PGHOST=$HOST
PGPORT=$PORT
PGDATABASE=$DATABASE
ENV

say "container $CONTAINER, volume $VOLUME, database $DATABASE"
say "DATABASE_URL and DATABASE_ADMIN_URL written to .local/db.env"
