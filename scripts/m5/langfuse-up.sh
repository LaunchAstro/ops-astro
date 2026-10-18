#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Brings the M5's existing Langfuse back at its pinned images after a restart
# or login (deploy/m5/langfuse.md). Its LaunchAgent runs it once at load. It
# waits for Docker, opening Docker Desktop once if it is not answering, then
# starts the installation's own Compose project with the repository's pins as
# the last file. It never stops, removes or recreates by itself, and it never
# creates settings: a missing installation file is refused before Docker is
# touched. It prints a reason, never a setting.
set -eu

install_dir=${LANGFUSE_INSTALL_DIR:?LANGFUSE_INSTALL_DIR is not set}
repo_dir=${LANGFUSE_REPO_DIR:?LANGFUSE_REPO_DIR is not set}
wait_seconds=${LANGFUSE_DOCKER_WAIT_SECONDS:-600}
pins="$repo_dir/deploy/m5/langfuse-pins.override.yml"

say() { printf 'langfuse up: %s\n' "$1"; }

for file in "$install_dir/docker-compose.yml" "$install_dir/docker-compose.override.yml" \
  "$install_dir/.env" "$pins"; do
  if [ ! -f "$file" ]; then
    say "refused, missing ${file##*/}"
    exit 1
  fi
done

waited=0
until docker info >/dev/null 2>&1; do
  if [ "$waited" -ge "$wait_seconds" ]; then
    say "refused, Docker did not start within ${wait_seconds}s"
    exit 1
  fi
  if [ "$waited" -eq 0 ]; then open -g -a Docker >/dev/null 2>&1 || true; fi
  sleep 5
  waited=$((waited + 5))
done

cd "$install_dir"
docker compose --project-name langfuse -f docker-compose.yml -f docker-compose.override.yml \
  -f "$pins" up --detach --no-build --pull missing
say 'started at the pinned images'
