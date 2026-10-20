# Existing M5 Langfuse installation

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

Read-only inventory captured on 14 October 2026 for ticket #1622. This file
does not configure or activate the deployment. Follow the
[inspection and exporter runbook](../../docs/local/LANGFUSE.md).

## Installation provenance

The Compose project is `langfuse`. Its Docker label
`com.docker.compose.project.working_dir` identifies the machine-local
installation directory, which contains these files:

- `docker-compose.yml`, owned by `agencyastro`, created at
  `2026-09-06T13:20:39Z`, mode `0644`.
- `docker-compose.override.yml`, owned by `agencyastro`, created at
  `2026-09-06T13:22:16Z`, mode `0644`.

The six containers and five named volumes were created at approximately
`2026-09-06T13:23:17Z`. Volume labels identify Docker Compose 5.1.4.
The installation README records 6 September 2026, but names no installer.
The directory has no `.git` metadata. These facts identify the account and
deployment method. They do not identify the person or agent who ran Compose.

The settings file is `.env`, owned by `agencyastro`, mode `0600`. Only its
setting names were inspected. No credentials were copied into this repository.

The base Compose file's SHA-256 is
`d373385b2ad54d11c4d26a66c70ee7eaab87c7088adeb6a017c6612143efc697`.
It matches the vendor file recorded in the repository's existing trace-target
pin. The override's SHA-256 is
`1812d2452f5727f3bbe3aeb5c9471705a01170fb547b1d0e40beb800403ea83d`.
The repository's hardened override is a different profile.

## Running services

All six inspected containers use `restart: unless-stopped`. All published
ports bind to `127.0.0.1`.

| Container                    | Configured image                                 | Host port to container port |
| ---------------------------- | ------------------------------------------------ | --------------------------- |
| `langfuse-langfuse-web-1`    | `docker.langfuse.com/langfuse/langfuse:4`        | 3400 to 3000                |
| `langfuse-langfuse-worker-1` | `docker.langfuse.com/langfuse/langfuse-worker:4` | 3030 to 3030                |
| `langfuse-postgres-1`        | `docker.io/postgres:17`                          | 5432 to 5432                |
| `langfuse-redis-1`           | `docker.io/redis:7`                              | 6379 to 6379                |
| `langfuse-clickhouse-1`      | `docker.io/clickhouse/clickhouse-server:25.12`   | 8123 to 8123, 9000 to 9000  |
| `langfuse-minio-1`           | `cgr.dev/chainguard/minio`                       | 9390 to 9000, 9391 to 9001  |

The web package and health endpoint both report `4.30.0`.
An unauthenticated request to `/api/public/projects` returns HTTP 401.
The configured references above are floating tags, so the next pull can
change the running version.

A read-only `docker ps -a` on 18 October 2026 listed five containers in the
project. `langfuse-minio-1` was absent; the other five reported up for 11
days. Langfuse v4 writes raw events to that blob store, so ingestion and the
replay acceptance are expected to fail until it is back. The Compose command
under Image pins creates it again on the existing
`langfuse_langfuse_minio_data` volume. That is an owner step.

## Image pins

[`langfuse-pins.override.yml`](langfuse-pins.override.yml) pins each service
to the image it ran on 14 October 2026. Each digest is the running
container's image ID, read with `docker inspect` and
`docker image inspect --format '{{json .RepoDigests}}'`. The version tags
come from the running images and the registry:

- Web and worker carry the OCI version label `4.30.0`, revision
  `2f00fd4b504ae9de37dcd0a02b01ee02ee67d3dd`.
  `docker buildx imagetools inspect` resolves both `4.30.0` tags to the
  pinned digests.
- ClickHouse reports `25.12.11.4`, and that registry tag resolves to the
  pinned digest.
- Postgres reports `17.11` and Redis reports `7.4.11`. Those registry tags
  now resolve to newer builds, so the file keeps the configured major tags.
  The digest is what runs.
- MinIO reports `RELEASE.2026-07-17T12-07-51Z`. Its publisher's free tier has
  no version tag, so only the digest pins it.

The file also sets three settings on web and worker: `AUTH_DISABLE_SIGNUP=true`
on web, and `LANGFUSE_MEDIA_UPLOAD_ENABLED=false` and `TELEMETRY_ENABLED=false`
on both. It changes nothing else, so ports, volumes, restart policies and the
`.env` file stay the installation's own. The test
`tests/runtime/m5-langfuse-pinned-setup.test.ts` holds it to that, and checks
that it names only services of the installed vendor file.

The running containers still use the floating references. The pins take
effect only when the owner adds this file as the last `-f` file to the
installation's Compose command, as in the following step. That step
recreates the web and worker containers with the new settings, and every
container whose reference changes, so it is an owner step:

```sh
docker compose --project-name langfuse -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f <repository>/deploy/m5/langfuse-pins.override.yml up --detach --no-build
```

After that step, `docker inspect --format '{{.Config.Image}}'` must show the
pinned reference on all six containers. Keep 4.30.0 for the run week. If the
replay acceptance fails on it, move to the proof-matched 4.33.0 digests in
[supply-chain pins](../../docs/supply-chain-pins.md), never to a 4.6x release.
Upgrading past 4.37 needs #1722 first.

## Start at boot

`unless-stopped` restarts containers when Docker starts, but not containers
someone stopped, and only if Docker Desktop itself starts. The LaunchAgent
[`ops-astro-langfuse.plist`](ops-astro-langfuse.plist) runs
[`scripts/m5/langfuse-up.sh`](../../scripts/m5/langfuse-up.sh) once at login.
The script waits up to ten minutes for Docker, opening Docker Desktop once if
it is not answering, then runs the Compose command above. It refuses an
installation missing its Compose files or `.env`, never creates settings, and
never stops, removes or recreates by itself. It prints a reason, never a
setting.

To install it, an owner step, replace the `@...@` placeholders: the
repository checkout, a `PATH` that finds `docker` and `open`, the installation
directory, and a log file. Then copy it to `~/Library/LaunchAgents/` and load
it with `launchctl bootstrap gui/$(id -u)`. The M5 account must log in after a
restart for a LaunchAgent to run.

Read-only `tailscale serve status --json` confirms HTTPS port 8449 forwards
to `http://127.0.0.1:3400`. Funnel is disabled on that port. The tailnet ACL
and access from the owner's other machines were not tested.

Both web and worker have `TELEMETRY_ENABLED=false`,
`LANGFUSE_S3_BATCH_EXPORT_ENABLED=false`, and
`CLICKHOUSE_CLUSTER_ENABLED=false`. Neither has a non-empty Enterprise
licence. `AUTH_DISABLE_SIGNUP` and `LANGFUSE_MEDIA_UPLOAD_ENABLED` are absent
from the inspected environments. Absence does not prove those features are
disabled. Project seed identifiers are present on web, but project API keys
are not supplied in its initialisation environment. Existing project keys
in the database were not inspected.

## Persistent volumes

| Named volume                        | Container path               |
| ----------------------------------- | ---------------------------- |
| `langfuse_langfuse_postgres_data`   | `/var/lib/postgresql/data`   |
| `langfuse_langfuse_redis_data`      | `/data`                      |
| `langfuse_langfuse_clickhouse_data` | `/var/lib/clickhouse`        |
| `langfuse_langfuse_clickhouse_logs` | `/var/log/clickhouse-server` |
| `langfuse_langfuse_minio_data`      | `/data`                      |

Web and worker have no mounted volumes. Do not remove or reuse the existing
store volumes. No backup or restore proof was performed in this inspection.

## Acceptance status

#1622 is partly met and requires owner input. The service exists, is healthy,
has persistent stores, and uses loopback ports and container restart policies.
The repository now holds the pinned setup: the pins with their settings, the
boot script and its LaunchAgent, and the live checks in
`tests/runtime/m5-trace-live.test.ts`. Applying the pins, loading the
LaunchAgent, a cold boot, owner-machine access, exporter activation, a
retrieved no-content replay trace, live outage recovery and the production
migration `20261014152243_run_event_written_at` remain owner steps. None of
the repository files changes runtime state.

The existing containers must remain running and unchanged. Do not start a
second Langfuse stack. Log `BLOCKER` before any proposed container change.
