# Staging

Staging is a separate, isolated copy of the system on the installation's own
production machine (ticket S0-1). This folder is its definition, and nothing
here deploys it: the first deploy is S0-6, once S0-2's alerts reach the owner.

`compose.json` is a Docker Compose file written as JSON, so the CI tests read
it without a YAML parser. It holds staging's own services: its Postgres, on
the same major as production's managed database (17), and its auth server,
the same pinned build the local slice runs. The API and the web bundle join
in S0-6 as app services, run from the image the deploy builds (below).
`x-ops-astro` names what other scripts read: the prefix every
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
`scripts/local-seed.mjs` decides from what it installed itself, never from a
tenant's rows (`scripts/ops/made-up-only.ts`). Before its first write it puts a
guard on every tenant table and on `auth.users`, and at the end it marks the
database. After that, a write by the owner or a superuser that the seed did not
make, as a restore or a hand-loaded file is, a sign-in outside `.local`, or a
guard switched off is noted, and the seed refuses the database. Writes through
the application are what people type on staging, and pass. A new database, whose
tenant tables have never held a row, is confirmed once by a person with
`LOCAL_SEED_MADE_UP=confirm`. A marked database that was migrated with a data
change, or refused for any reason, is started again empty: its container's
data does not survive a restart.

Backups are never restored into staging: the restore drill takes no target and
restores only into a throwaway container of its own.

The backup store is a database server of its own, `backups`
(`ops-astro-staging-backups`), on staging's internal network with no port on
the machine. Its data is on `ops-astro-staging-backups-data`, the one
persistent volume staging has, so backups and drill receipts outlive a restart
while staging's own database, memory-backed, does not. S0-1's disk row names
that volume as its only exception; the store bounds it itself (`S0-3 store
bounded`).

The restore drill is a person's act under `operations:manage`, asked of the
operator gate before anything else, like staging preparation and the promotion.
Each drill it runs, passed or failed, leaves a receipt in the backup store
(`backups.drills`: time, outcome, stage, majors, table count, stage timings
and the operator; no record data, key, credential, fingerprint or path) and a
line in the operator's record folder. The receipt names the date of the last
tested restore. The daily upkeep job (`backup.mjs expire`) pings the restore
heartbeat only while a drill passed within `backups.settings.restore_days`
(35 to start); once none has, the watcher mails the owner and the second
operator that the restore drill is out of date.

A drill can also run on a host with no route to the store (the runbook's
clean-host leg), under the same gate. Every drill mode is the installation's
operating business's act alone: the one row the installation wrote into
`ops.operating_business` (migration 0045), read in the same transaction and
on the same database as the grant is checked, so no value or database
address the caller sets replaces it. The store checks the same appointment
again before it hands out a byte (`backups.read_latest(person, business)`). The backup is the whole database, so another business's manager is
refused and learns nothing. `restore-drill.mjs --export <file>` on the
machine writes the newest sealed backup and its facts beside it: the store's
id for it, its time, size and recorded digest (never the key, and no step
prints the digest); `--drill --archive <file>` on the other host checks the
file against that digest before opening it with the operator's own copy of
the key, and keeps and prints a receipt that says it ran on a carried archive
and reads `pending` (it is not a passed drill yet); `--record <receipt>
--archive <file>` on the machine computes the digest again from the file and
hands it, the archive's id and the business to the store as bound parameters
(`backups.record_carried_drill`). The receipt names the store's own id for
the archive its drill restored, and `--record` refuses it with any other
archive, even one taken at the same time. The store takes it once, for the operator
who ran it in the business it ran in, only for the very archive (by its id)
it handed out to the same login, whose digest is the one it recorded, so an
archive swapped on the way is refused.

A passed drill, on the machine or carried, is the appointed operator's own
attestation that they ran the real restore on a clean throwaway host: no
value in a dump can prove it, since the key holder reads every value in one
without restoring anything. So the store takes a pass only through the store
login the installation appointed as that person (`backups.appointed`), in the
operating business (`backups.installation`), both written by the store's
admin at installation; the restore command admits the same person only after
verifying their sign-in there. The restore identity alone records a failed
drill and never a pass.

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

## The deploy

`scripts/ops/deploy.mjs --version <id> --artefacts <store>` deploys a stored
build to staging (ticket S0-6). It is a person's act under
`operations:manage`, asked of the operator gate before anything else, like
the preparation and the promotion. It takes the artefact the store holds for
that version, checked as the promotion checks it, and never builds the
product. Before anything starts, staging's database (`DATABASE_ADMIN_URL`)
must pass the made-up-only preflight; a sign refuses the deploy. It builds one image from that artefact on the pinned base (the
staging Dockerfile, which arrives with the release artefact in S0-6e; until
then the deploy stops at its build and records nothing), with nothing from
the machine mounted, and Compose runs the app services on that image by its
id. Every other service
is named by a digest with a row in `docs/supply-chain-pins.md`, and a
service Compose could build or pull another way is refused (`S0-6 image
pins`). After Compose is up, each container must be on the image it was named
by.

The deploy takes the service report's snapshot before and after, and a live
service that stopped, restarted or changed fails it (`S0-6 services
unchanged`). Only a deploy that passes both writes `deploy recorded` to the
operator's record folder: the version, the artefact and the image id.

The web app goes to Vercel with `scripts/ops/web-deploy.mjs --version <id>
--artefacts <store>` (the Vercel re-plan, step 4), beside the deploy above.
The same gate comes first, the same stored build output and preflight are
checked, and the output is copied into a folder of its own and checked again
there. It runs `vercel deploy --prebuilt --prod` under the person's own Vercel
sign-in (`VERCEL_TOKEN` set refuses it) into the project `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` name, handing the CLI nothing else from the environment,
then reads the deployment's region back with `vercel inspect`. Only a
deployment Vercel reports in `syd1` alone writes `deploy recorded`: the
version, the artefact, the digest, the deployment's own address, the region
and the function runtime. The folder, `.vercel` included, is removed either
way.

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
(UptimeRobot, off the machine) checks each environment's web page, API health,
backup, restore and forwarder heartbeats, and the error sink's health; the error sink (GlitchTip)
takes the API's errors and its security alerts. The API on Vercel keeps no
count and reaches no sink: it appends each signal and error to its own
database's outbox (`ops.api_events`), and the environment's forwarder
(`pnpm forwarder`, on the machine) counts, sends, clears and pings its
heartbeat; rows it did not handle within an hour are dropped with one alert. The API raises repeated
failed sign-ins, a burst of cross-scope refusals, a grant or delegation
revoked, and unusual download volume (the records its reads hand out, per
reader, people's and agents' reads alike, 5,000 an hour to start);
`scripts/secrets-scan.mjs` raises a failed secret scan, one that cannot
start included. Webhook signature failures (follow-up #147), custody changes
and exports raise theirs once those features exist. Each mails the owner and the second operator at once,
from its own mail, in the plain words of `apps/api/alerts/catalogue.ts`. The
addresses are private, set in the environment at run time:

| Variable                                                   | Read by                                      | Holds                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS_ALERT_OWNER_EMAIL`, `OPS_ALERT_SECOND_OPERATOR_EMAIL` | `alerts.mjs plan`                            | the two alert addresses                                                                                                                 |
| `OPS_ALERT_TEST_EMAIL`                                     | `alerts.mjs plan --test`                     | the test address agreed before case R8's proof                                                                                          |
| `OPS_WATCH_STAGING_URL`, `OPS_WATCH_PRODUCTION_URL`        | `alerts.mjs plan`                            | the public https addresses watched; production's from the first promotion                                                               |
| `OPS_ERROR_SINK_DSN`                                       | the forwarder, `alerts.mjs`, the secret scan | the sink's DSN; never the Vercel function's (it refuses to start beside it)                                                             |
| `OPS_ENVIRONMENT`, `OPS_RELEASE`                           | the API, the forwarder, `alerts.mjs test`    | `staging` or `production`; the build stamp                                                                                              |
| `ALERT_SCOPE_KEY`                                          | the API (the Vercel function)                | at least 32 bytes as hex (`openssl rand -hex 32`), one per environment, every instance the same; required once `OPS_ENVIRONMENT` is set |
| `DATABASE_FORWARDER_URL`                                   | `forwarder.mjs`                              | a login that is a member of `ops_astro_forwarder` alone                                                                                 |
| `OPS_FORWARDER_HEARTBEAT_URL`                              | `forwarder.mjs`                              | the watcher's forwarder heartbeat, pinged after each pass that completed                                                                |
| `OPS_BACKUP_HEARTBEAT_URL`                                 | `backup.mjs run`                             | the watcher's backup heartbeat, pinged once a backup is recorded                                                                        |
| `OPS_RESTORE_HEARTBEAT_URL`                                | `backup.mjs expire`                          | the watcher's restore heartbeat, pinged only while a drill is fresh                                                                     |

`node scripts/ops/alerts.mjs plan` prints the checks, each with its name and
its alert message in plain words, and the recipients to set up in both services (`--test`: all mail to the test address). `node
scripts/ops/alerts.mjs test` sends a test alert through the sink.
