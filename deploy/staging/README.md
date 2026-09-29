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

Staging's database holds made-up data only (`S0-1 no production data`).
`scripts/local-seed.mjs` refuses a database with no made-up mark, reading
nothing else. It marks a database with the businesses and people it made, and
refuses a marked one holding any other, a record of a type it never installs,
or a sign-in outside `.local`. A new database, or one seeded before the mark,
is confirmed once by a person with `LOCAL_SEED_MADE_UP=confirm`.

Before staging is prepared, and again after, the owner runs
`scripts/ops/service-report.mjs` on the machine:

```sh
node scripts/ops/service-report.mjs snapshot > before.json
# prepare staging, as the runbook says
node scripts/ops/service-report.mjs snapshot > after.json
node scripts/ops/service-report.mjs compare before.json after.json
```

It exits 1 when a live service stopped, restarted, vanished, moved port or
was reconfigured, and 0 when all are unchanged (`S0-1 services unchanged`).
