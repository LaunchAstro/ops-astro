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

- Every service sits on the `staging` network, which is internal, has no
  gateway (isolated gateway mode) and no IPv6: it has no route out and no
  address on the machine, so the machine, its other containers, the cloud metadata address,
  private addresses and the internet are all unreachable from inside. No service publishes a port. Operators reach staging through its own
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

The promotion refuses while production's API or auth server runs (owner line
63), so a person stops them first with `scripts/ops/stop-production.mjs`. It
asks the operator gate before anything else, then stops the containers
`ops-astro-api` and `ops-astro-auth` and records the stop. It takes no
argument, so no caller can point it at another service. Those two names are
the one part of production's layout this repository holds, because a stop
with no input has to name its services itself; S0-6's deploy gives the
containers these names (`S0-1 gated stop`).

## Alerts

Nothing deploys before the alerts reach the owner (ticket S0-2). The watcher
(UptimeRobot, off the machine) checks each environment's web page, API health
and backup heartbeat, and the error sink's health; the error sink (GlitchTip)
takes the API's errors and its security alerts. The API raises repeated
failed sign-ins, a burst of cross-scope refusals, a grant or delegation
revoked, and unusual download volume (the records its reads hand out, per
reader, 5,000 an hour to start); `scripts/secrets-scan.mjs` raises a failed
secret scan. Webhook signature failures, custody changes and exports raise
theirs once those features exist. Each mails the owner and the second operator at once,
from its own mail, in the plain words of `apps/api/alerts/catalogue.ts`. The
addresses are private, set in the environment at run time:

| Variable                                                   | Read by                                | Holds                                                                     |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `OPS_ALERT_OWNER_EMAIL`, `OPS_ALERT_SECOND_OPERATOR_EMAIL` | `alerts.mjs plan`                      | the two alert addresses                                                   |
| `OPS_ALERT_TEST_EMAIL`                                     | `alerts.mjs plan --test`               | the test address agreed before case R8's proof                            |
| `OPS_WATCH_STAGING_URL`, `OPS_WATCH_PRODUCTION_URL`        | `alerts.mjs plan`                      | the public https addresses watched; production's from the first promotion |
| `OPS_ERROR_SINK_DSN`                                       | the API, `alerts.mjs`, the secret scan | the sink's DSN; unset, the API runs with no sink                          |
| `OPS_ENVIRONMENT`, `OPS_RELEASE`                           | the API, `alerts.mjs test`             | `staging` or `production`; the build stamp                                |

`node scripts/ops/alerts.mjs plan` prints the checks, each with its name and
its alert message in plain words, and the recipients to set up in both services (`--test`: all mail to the test address). `node
scripts/ops/alerts.mjs test` sends a test alert through the sink.
