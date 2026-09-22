#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Stop the working slice's Postgres without forgetting anything.
#
# It stops the container and does not remove it, and it never touches the named
# volume. That is the whole point: acceptance case B6 restarts this server and
# expects the task, its history and its revisions to still be there, so a
# "down" that took the volume with it would make the case unrunnable.
#
# Removing the data is a deliberate, separate act:
#   docker rm -f ops-astro-local-pg && docker volume rm ops-astro-local-pgdata

set -euo pipefail

CONTAINER=ops-astro-local-pg

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  printf 'db-down: %s does not exist; nothing to stop\n' "$CONTAINER"
  exit 0
fi

docker stop "$CONTAINER" >/dev/null
printf 'db-down: %s stopped. The named volume ops-astro-local-pgdata is untouched.\n' "$CONTAINER"
