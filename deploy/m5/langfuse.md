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
The current image IDs identify what is running, but the Compose references
above do not pin the same images for the next pull.

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
Pinned deployment references, machine-restart behaviour, owner-machine access,
exporter activation, a retrieved no-content replay trace, and live outage
recovery remain unverified or unmet. The repository now contains a runbook and
an inactive exporter configuration example. Neither changes runtime state.

The existing containers must remain running and unchanged. Do not start a
second Langfuse stack. Log `BLOCKER` before any proposed container change.
