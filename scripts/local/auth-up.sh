#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bring up the working slice's own Supabase Auth (GoTrue), idempotently.
#
# Three things this script is careful about.
#
# It never touches the Hub's `supabase_*` containers. The only names it will
# create or start are the two the local slice contract names, and the Hub's
# stack keeps its own ports.
#
# It owns the `auth` schema in the slice's Postgres and nothing else. GoTrue
# runs its own migrations there, which is why the schema is created here and
# then handed over rather than described by a migration of ours.
#
# It is convergent with SLICE-DATA's `db-up.sh`. If the Postgres container is
# already running, this script reads `.local/db.env` and uses it. If it is not,
# this script starts the same container, at the same pinned digest, on the same
# port, with the same named volume, so whichever script runs first the other
# finds what it expects.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL="${ROOT}/.local"
mkdir -p "${LOCAL}"

PG_CONTAINER=ops-astro-local-pg
PG_IMAGE=postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
PG_VOLUME=ops-astro-local-pgdata
PG_PORT=54390
PG_DATABASE=ops_astro_local

AUTH_CONTAINER=ops-astro-local-auth
AUTH_IMAGE=public.ecr.aws/supabase/gotrue:v2.192.0
AUTH_PORT=54391

NETWORK=ops-astro-local

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ]; }
exists() { docker inspect "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- the network
# Both containers share a user-defined network so GoTrue reaches Postgres by
# container name. The published ports stay on 127.0.0.1 for people.
docker network inspect "${NETWORK}" >/dev/null 2>&1 || docker network create "${NETWORK}" >/dev/null

# --------------------------------------------------------------- the database
if ! running "${PG_CONTAINER}"; then
  if exists "${PG_CONTAINER}"; then
    echo "auth-up: starting the existing ${PG_CONTAINER}"
    docker start "${PG_CONTAINER}" >/dev/null
  else
    echo "auth-up: ${PG_CONTAINER} is absent; starting it with the contract's identity"
    docker volume inspect "${PG_VOLUME}" >/dev/null 2>&1 || docker volume create "${PG_VOLUME}" >/dev/null
    docker run -d \
      --name "${PG_CONTAINER}" \
      --network "${NETWORK}" \
      -p "127.0.0.1:${PG_PORT}:5432" \
      -v "${PG_VOLUME}:/var/lib/postgresql" \
      -e POSTGRES_PASSWORD=ops_astro_local \
      -e POSTGRES_DB="${PG_DATABASE}" \
      "${PG_IMAGE}" >/dev/null
  fi
fi

# Additive, and safe to repeat: whoever started the container, it has to be
# reachable by name from GoTrue.
docker network connect "${NETWORK}" "${PG_CONTAINER}" >/dev/null 2>&1 || true

echo -n "auth-up: waiting for Postgres"
for _ in $(seq 1 60); do
  if docker exec "${PG_CONTAINER}" pg_isready -U postgres -d "${PG_DATABASE}" >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n .
  sleep 1
done
docker exec "${PG_CONTAINER}" pg_isready -U postgres -d "${PG_DATABASE}" >/dev/null 2>&1 || {
  echo
  echo "BLOCKER: ${PG_CONTAINER} did not become ready" >&2
  exit 1
}

# `.local/db.env` belongs to SLICE-DATA's db-up.sh. It is written here only
# when it does not exist yet, so the two lanes converge on one file rather than
# overwriting each other's.
if [ ! -f "${LOCAL}/db.env" ]; then
  cat > "${LOCAL}/db.env" <<ENV
# Written by scripts/local/auth-up.sh because SLICE-DATA's db-up.sh had not run.
# Local only, gitignored. The application role is created by the migrations.
DATABASE_ADMIN_URL=postgres://postgres:ops_astro_local@127.0.0.1:${PG_PORT}/${PG_DATABASE}
DATABASE_URL=postgres://app:ops_astro_local@127.0.0.1:${PG_PORT}/${PG_DATABASE}
ENV
  echo "auth-up: wrote ${LOCAL}/db.env"
fi

# GoTrue owns schema `auth` and migrates it itself; it does not create it.
docker exec "${PG_CONTAINER}" psql -U postgres -d "${PG_DATABASE}" -v ON_ERROR_STOP=1 \
  -c 'create schema if not exists auth' >/dev/null

# ------------------------------------------------------------- the JWT secret
# Generated once and then kept, because regenerating it would invalidate every
# token the slice has already issued and every seeded session.
if [ -f "${LOCAL}/auth.env" ]; then
  # shellcheck disable=SC1091
  . "${LOCAL}/auth.env"
else
  SUPABASE_JWT_SECRET="$(openssl rand -hex 32)"
  cat > "${LOCAL}/auth.env" <<ENV
# Written by scripts/local/auth-up.sh. Local only, gitignored.
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}
GOTRUE_URL=http://127.0.0.1:${AUTH_PORT}
ENV
  echo "auth-up: wrote ${LOCAL}/auth.env"
fi
# shellcheck disable=SC1091
. "${LOCAL}/auth.env"

# ------------------------------------------------------------------- the auth
if running "${AUTH_CONTAINER}"; then
  echo "auth-up: ${AUTH_CONTAINER} already running"
else
  if exists "${AUTH_CONTAINER}"; then
    # A stopped container may hold an older secret in its environment, so it is
    # replaced rather than started. Its state lives in Postgres, not here.
    docker rm -f "${AUTH_CONTAINER}" >/dev/null
  fi
  docker run -d \
    --name "${AUTH_CONTAINER}" \
    --network "${NETWORK}" \
    -p "127.0.0.1:${AUTH_PORT}:9999" \
    -e GOTRUE_API_HOST=0.0.0.0 \
    -e PORT=9999 \
    -e API_EXTERNAL_URL="http://127.0.0.1:${AUTH_PORT}" \
    -e GOTRUE_SITE_URL="http://127.0.0.1:5190" \
    -e GOTRUE_DB_DRIVER=postgres \
    -e GOTRUE_DB_NAMESPACE=auth \
    -e DATABASE_URL="postgres://postgres:ops_astro_local@${PG_CONTAINER}:5432/${PG_DATABASE}?sslmode=disable&search_path=auth" \
    -e GOTRUE_JWT_SECRET="${SUPABASE_JWT_SECRET}" \
    -e GOTRUE_JWT_AUD=authenticated \
    -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
    -e GOTRUE_JWT_ADMIN_ROLES=service_role \
    -e GOTRUE_JWT_EXP=3600 \
    -e GOTRUE_DISABLE_SIGNUP=false \
    -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
    -e GOTRUE_MAILER_AUTOCONFIRM=true \
    -e GOTRUE_MAILER_AUTOCONFIRM_ENABLED=true \
    -e GOTRUE_SMTP_HOST= \
    -e GOTRUE_LOG_LEVEL=info \
    "${AUTH_IMAGE}" >/dev/null
  echo "auth-up: started ${AUTH_CONTAINER}"
fi

echo -n "auth-up: waiting for GoTrue"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${AUTH_PORT}/health" >/dev/null 2>&1; then
    echo " ready"
    curl -fsS "http://127.0.0.1:${AUTH_PORT}/health"; echo
    exit 0
  fi
  echo -n .
  sleep 1
done

echo
echo "BLOCKER: GoTrue did not answer /health on 127.0.0.1:${AUTH_PORT}" >&2
docker logs --tail 40 "${AUTH_CONTAINER}" >&2 || true
exit 1
