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
and volume. Ports are published on loopback only. Every credential and every
port is a `${STAGING_*}` placeholder, and Compose refuses to start with one
unset. The values and the machine's layout (ports, service names, data paths)
live in the private staging runbook, never in this repository.

Staging's database holds made-up data only. `scripts/local-seed.mjs` marks a
database with the businesses and people it made there, and refuses one
holding any other business or person, an unmarked one holding data, or a
sign-in that is not a made-up `.local` address: what a restored production
backup looks like (`S0-1 no production data`). A database seeded before the
mark is confirmed once by a person, with `LOCAL_SEED_MADE_UP=confirm`, which
still refuses any business or person the seed does not make.

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
