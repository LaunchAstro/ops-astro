# Staging

Staging is a separate, isolated copy of the system on the installation's own
production machine (ticket S0-1). This folder is its definition, and nothing
here deploys it: the first deploy is S0-6, once S0-2's alerts reach the owner.

`compose.json` is a Docker Compose file written as JSON, so the CI tests read
it without a YAML parser. It holds staging's own services: its Postgres, on
the same major as production's managed database (17), and its auth server,
the same pinned build the local slice runs. The API and the web bundle join
in S0-6. `x-ops-astro` names what other scripts read: the prefix every
staging name carries, the production major and the artefact the promotion
step selects.

Everything staging owns is named `ops-astro-staging*`: containers, network
and volume. Every credential is a `${STAGING_*}` placeholder, and Compose
refuses to start with one unset. The values and the machine's layout (ports,
service names, data paths) live in the private staging runbook, never in this
repository.

## Containment and limits

Staging shares a machine with live services, so it is confined (ticket S0-1,
`S0-1 containment` and `S0-1 resource limits` in
`tests/ci/staging-containment.test.ts`):

- Every service sits on the `staging` network, which is internal: it has no
  route out, so the machine, its other containers, the cloud metadata
  address, private addresses and the internet are all unreachable from
  inside. No service publishes a port. Operators reach staging through its own
  network only: `docker compose exec`, or a one-off `docker compose run` for
  the runbook's seed and migrate steps.
- No service mounts a path from the machine, reads an env file or secret from
  it, joins the host's network or namespaces, or gains a capability. Every
  root filesystem is read-only.
- Each service has a CPU share, a memory limit with no swap beyond it, a
  process limit and rotated logs (three files of 10 MB). The only places a
  service can write are sized tmpfs mounts inside its memory limit, so staging
  cannot fill the machine's disk.

The database's files live on a 512 MB tmpfs volume, so staging's data does not
survive the database container stopping. It holds made-up data only, and the
runbook migrates and seeds it again after a restart.

Staging's database holds made-up data only. `scripts/local-seed.mjs` refuses
a database that carries a business it does not make or a sign-in address
that is not a made-up one, which is what a restored production backup looks
like (`S0-1 no production data`).

Before staging is prepared, and again after, the owner runs
`scripts/ops/service-report.mjs` on the machine:

```sh
node scripts/ops/service-report.mjs snapshot > before.json
# prepare staging, as the runbook says
node scripts/ops/service-report.mjs snapshot > after.json
node scripts/ops/service-report.mjs compare before.json after.json
```

The report reads Docker's containers and launchd's jobs and keeps only names,
state, start times, images and ports, never environments or arguments. It
exits 1 when a live service stopped, restarted, vanished or moved port, and 0
when every live service is unchanged (`S0-1 services unchanged`).
