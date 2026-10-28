# Production

Production is ops.agencyastro.com: its own Supabase project for the database
and sign-in, and its own Vercel project for the web app and API. Its tooling is
staging's, run with `--production`. Without that flag every command acts on
staging, with every staging guard it had. With it, the command acts on
production's project alone and refuses staging's. Nothing here deploys
anything: a person runs each step.

Production holds real data, so staging's made-up-only rules do not apply to it.
Staging's commands still refuse production's project.

Each command below reads two project references: `PRODUCTION_PROJECT_REF`
and `STAGING_PROJECT_REF`. Both must be set, and they must differ, so each
command can refuse the other's project. The values and the machine's layout
live in the private production runbook, never in this repository.

## Database logins

```sh
node scripts/ops/staging-logins.mjs before-reset --production
# migrate production's database
node scripts/ops/staging-logins.mjs after-reset --production
```

The command makes the same logins in the same groups as staging's
([staging README](../staging/README.md), `staging-logins.ts`). `before-reset`
makes the app group and the runtime login before the first migration.
`after-reset` makes one login for each group the migrations made: the lookup,
the backup identity, the forwarder and the upkeep job. Production has no reset,
so the step names keep staging's names.

`DATABASE_ADMIN_URL` is production's own login through Supabase's Sydney
session pooler, with `sslmode=require` or stricter. The command refuses an
admin address on staging's project or on any project but production's. It
writes each address to an owner-only file in a new `OPS_LOGINS_DIR` for the
password manager and the M5's settings files. The owner deletes the folder
after use.

### How a migrate window drains

The window opens with the planned maintenance page (`web-deploy.mjs
--maintenance --version <id> --artefacts <store> --production`), naming the
version that takes it off, so production is never left on the page by a deploy
that cannot run.

A migration refuses while any other session is connected, so production's
database drains the way staging's does ([staging README](../staging/README.md),
"How a migrate window drains"): the API's alias detached, the worker and
forwarder stopped (`scripts/ops/stop-production.mjs`), then a wait of about a
minute while the function's idle connections close (20 seconds without a
statement, `RUNTIME_IDLE_SECONDS`). A session left after that is read in
`pg_stat_activity` before anything ends it.

## The first business and its owner

Production starts with no business. After the migrations and the logins, the
operator makes the first business and its owner, once, in two steps.

1. Make the owner's sign-in through Supabase Auth's admin API with
   production's secret key: `POST /auth/v1/admin/users` with the owner's
   email, a generated password and `"email_confirm": true`, so no mail is
   sent. Store the password in the password manager before the call. Keep the
   `id` from the reply.
2. Run the bootstrap with that `id`, and with `PRODUCTION_PROJECT_REF`,
   `STAGING_PROJECT_REF` and `DATABASE_ADMIN_URL` set as for the logins:

```sh
node scripts/ops/production-bootstrap.mjs --business-key <key> \
  --business-name <name> --owner-name <name> --owner-subject <sign-in id>
```

Before it connects, the command refuses an admin address on staging's project,
on any project but production's, or without TLS. It refuses when any business
already exists, so it runs once. In one transaction it writes:

- the business, with the task model and its default settings installed;
- the owner's person, acting identity, login and admin membership;
- the local seed's admin grants plus `operations:manage`;
- the business as the operating business and the installation's operator.

A failure keeps nothing. Every value is the operator's, so it writes no
made-up row. The installation mode stays `made-up` until every first-client
gate item is done (migration 0058).

## Agent sign-ins

An agent's sign-in is made, stopped and put back by a person holding
`operations:manage`, with `scripts/ops/agent-login.mjs`. Set
`OPS_ASTRO_TOKEN` (your own sign-in), `OPS_ASTRO_BUSINESS` (the business the
agent belongs to), `OPS_ASTRO_DEPLOYMENTS`, `DATABASE_ADMIN_URL`,
`DATABASE_URL`, `GOTRUE_URL`, `SUPABASE_SERVICE_KEY`, `PRODUCTION_PROJECT_REF`
and `STAGING_PROJECT_REF`, and add `--production` on production. Every address
must be on that one project, and each database address must ask for TLS.

To make one, run the custody wrapper, which creates the password in the
password manager once, reads it back, and hands it to the command on its
standard input. The password is never typed, never an argument and never a
file:

```sh
node agent-login-custody.mjs --agent-name <name> --generation 1 [--production] -- \
  make --agent <agent id> --email <address> [--production]
```

The address is on our own domain and is never mailed; the command adds the
generation to it. The command signs in as the agent and asks for its queue
before it says done. If it stops part way, run the same line again: it
resumes, and it never makes a second password.

To stop one, run `node scripts/ops/agent-login.mjs stop --agent <agent id>`.
It switches the agent off, revokes its delegations, ends every session of its
sign-in and bans its sign-in at the provider. If the provider does not answer,
the stop is kept and the ban is owed: run stop again until it says done. If
the same sign-in is live in another business, nothing is ended or banned
there, and the record says it was shared. After a stop, `docker stop` the
agent's runner, which otherwise exits on its own after ten refused passes.

To put one back, run the wrapper with `restore` in place of `make` and the
next generation, with the same address. A restore makes a new sign-in and
leaves the old one banned. It refuses while a ban is owed, after any
credential of the agent was revoked since the stop, and for an agent this
tool did not switch off.

Before ending a person's access, stop each agent that person owns. Ending
access does not yet stop their agents, and an agent whose owner has left is
never made or put back.

## The web deploy

```sh
node scripts/ops/web-deploy.mjs --version <id> --artefacts <store> --production
```

The same operator gate, stored build output, digest checks, sign-in server
version and Vercel read-back as staging's deploy apply. Production also takes
only the bytes staging ran. The stored output's digest must be the one
staging's web deploy recorded for that version in `OPS_ASTRO_DEPLOYMENTS`, so
run production's deploy with staging's record folder. The folder and every
folder above it must belong to root or the operator, with no group or other
write, as the promotion's link folders must. A tree put in the store under
that version since then is refused, even with a matching stamp and digest.
So is a version staging has no record of, and a version staging recorded
with two different digests. `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` name production's Vercel project. The one check left out
is staging's made-up-only preflight. A database that holds real sign-ins never
passes it.

While staging is off by the owner's decision, add `--staging-off <reference>`,
naming that decision (for example `DECISIONS 33`). It is production's alone and
needs a version. The digest must then be the one the release step recorded for
that version, so run the release with `OPS_ASTRO_DEPLOYMENTS` set to the
operator's record folder: it appends `release recorded`, the build and its
digest, once the output is checked. The same refusals apply to that line: a
tree put in the store since the release, a version with no release line, and
a version released twice with different digests. Every other check above and
below stays. The `deploy recorded` line carries `stagingRecord: "waived"` and
the reference as `waivedBy`. The planned maintenance page takes the flag too.
Without the flag, staging's record is required as before.

In its place, before Vercel or the database is asked:

- `DATABASE_ADMIN_URL` must reach production's project, and never staging's;
- `GOTRUE_URL` must be exactly `https://<production reference>.supabase.co/auth/v1`.

Production's own preflight then reads the database for signs that the made-up
seed ever ran there. It looks for the seed's mark on the database, the
`ops_astro_made_up` guard schema and the guard's watch. Any of these refuses
the deploy. It reads no business, person or sign-in row. It does not read the
installation mode, which stays `made-up` until every first-client gate item is
done (migration 0058).

A deploy that Vercel reads back as ready on production writes `deploy recorded`
to the operator's record folder (`OPS_ASTRO_DEPLOYMENTS`), as staging's does,
with `environment: "production"`. `--maintenance --production` puts the
maintenance page on production's address. In a window it takes the planned
form, `--maintenance --version <id> --artefacts <store> --production`: the
page goes up only if that version passes production's deploy checks now. The
bare form is for an incident.

### Rolling the web back

```sh
node scripts/ops/web-deploy.mjs --rollback <deployment> --production
```

`<deployment>` is the `https://<name>.vercel.app` address a `deploy recorded`
line with `environment: "production"` names in `OPS_ASTRO_DEPLOYMENTS`; any
other is refused. The same operator gate and settings apply. It uses Vercel's
instant rollback, which builds nothing, so the old build keeps the settings it
was made with. A fresh deploy of an old version would read today's settings,
which may hold something its API refuses, and with staging off it would need a
release record the old version may not have. Vercel must read the deployment
back as ready on production first: it answers a rollback to any other
deployment by building a new one with today's settings. Once Vercel's rollback
finishes, `rollback recorded` is written with the version and the deployment.

After a rollback Vercel gives new deployments no domain until one is promoted.
So production's next deploy runs `vercel promote` once it is read back, and
the maintenance page on production is refused until that deploy is recorded. A
rollback made outside this command, in the dashboard or by hand, is not in the
record: run `vercel promote <deployment>` after the next deploy yourself.

## The M5 unit

`compose.json` here is production's unit on the M5: the forwarder, the
backup store, and the two egress hops. The worker is in a file of its own,
`worker.json`, with the forwarder's wait for it. The two files together are
staging's definition with only the names changed
(`tests/ci/production-unit.test.ts` proves it). Everything production owns is
named `ops-astro-*`, and every credential is a `${PRODUCTION_*}` placeholder.
So staging's containment, limits, image pins and egress allow-list hold for
production too: see
[Containment and limits](../staging/README.md#containment-and-limits). The
worker and forwarder containers are `ops-astro-worker` and
`ops-astro-forwarder`, the pair `scripts/ops/stop-production.mjs` stops.

```sh
node scripts/ops/deploy.mjs --version <id> --artefacts <store> --production
```

Set `PRODUCTION_RELEASE` to that `<id>`, the build stamp being deployed, before
each run: it is the forwarder's `OPS_RELEASE`, the release on every event the
sink receives (see the staging runbook's deploy section, #1787).

The worker is parked: the deploy reads `compose.json` alone, so no
`PRODUCTION_WORKER_*` setting is needed and no worker sign-in is made in the
business. A profile cannot park it, because Compose requires every
`${...:?}` setting in a file, profile or not. No deploy starts `worker.json`
yet. A deploy records the unit only when Docker reports each of its
containers as `running`, so one that stopped, waits in restart backoff or
was paused fails it. `stop-production.mjs` stops a parked unit's forwarder
and records the stop: a worker that is not there is stopped already.

The deploy reads this definition, checks every image against its pin row and
runs production's preflight, as the web deploy does. Then it starts the unit
with `docker compose --file deploy/production/compose.json up`. It takes the
service report's snapshot before and after. Production's own containers are
left out of the compare, and staging's count as live services, so a
production deploy that restarts staging fails. A staging deploy likewise
counts production's containers as live. The record is `deploy recorded` with
`environment: "production"`.

The forwarder reports as `OPS_ENVIRONMENT=production`. The egress relay takes
the API's host from the worker's own `OPS_ASTRO_API_URL`, set from
`PRODUCTION_WEB_URL`.

## Backups and the restore drill

Production's backup store is `backups` in production's unit
(`ops-astro-backups`, on the internal `ops-astro` network, data on
`ops-astro-backups-data`). Its admin makes it as staging's is made, with
`../staging/backup-store.sql` and each numbered upgrade in order.

```sh
node --env-file=<backup env> scripts/ops/backup.mjs run --production
node --env-file=<retention env> scripts/ops/backup.mjs expire --production
node --env-file=<drill env> scripts/ops/restore-drill.mjs --drill --production
```

`--production` goes after the command or mode, for every drill mode:
`--export`, `--drill --archive` and `--record` too. Each reaches production's
store through psql in a throwaway container on production's network, named
`ops-astro-store-<hex>` (the dump's `ops-astro-backup-<hex>`), so production's
deploy counts these runs as its own. The runbook's sweep for runs left behind is
staging's with production's names:
`docker ps --all --filter 'name=^ops-astro-(store|backup)-[0-9a-f]{16}$'`.

The backup and retention env files also set `PRODUCTION_PROJECT_REF` and
`STAGING_PROJECT_REF`. A `BACKUP_SOURCE_URL` on staging's project, or on any
project but production's, fails the run as `config`. A `DATABASE_UPKEEP_URL`
off production's project skips the second-factor purge and says so.

`ops-astro-backup.plist` and `ops-astro-backup-expire.plist` are staging's two
launchd jobs renamed, run with `--production`.

The drill still takes no target. It restores only into its own container,
`ops-astro-drill-<hex>`, with no network, and never into production's
database. Its receipt's `ranOn` says `staging machine` for a drill on the M5:
that is the store's own value for "on the machine", shared by both stores.

## The scheduled occurrence sweep

`ops-astro-occurrence-sweep.plist` is staging's
[scheduled occurrence sweep](../staging/README.md#the-scheduled-occurrence-sweep)
job renamed: `node apps/automations/sweep.ts` every 60 seconds, its env file
`@PRODUCTION_SWEEP_ENV_FILE@` and its log `@PRODUCTION_SWEEP_LOG@`. The env
file holds the same four settings: `AUTOMATION_FIRING`,
`AUTOMATION_BUSINESS_KEYS`, `DATABASE_URL` (production's application login)
and `DATABASE_LOOKUP_URL`. Unset `AUTOMATION_FIRING` means off, and any value
but exactly `on` is off too.

The job ships unloaded, with its env file absent. Loading it is the owner's
switch-on step, A5 of #1653: after staging's proof, the runs gates and the
owner's go, in daylight. One sweeping entry per environment: this job or a
long-running API process with `AUTOMATION_FIRING=on`, never both.

## Alerts

Production's alerts are staging's [alerts](../staging/README.md#alerts), with
production named in their words. Every alert mails the owner
(`OPS_ALERT_OWNER_EMAIL`) and the second operator
(`OPS_ALERT_SECOND_OPERATOR_EMAIL`) at once. Nobody else gets them, and no
alert goes to a client or a business's own people.

| Alert                                                     | Raised by                                   | Who sees it                       |
| --------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| Production not loading, its API not answering             | the off-box watcher, every five minutes     | the owner and the second operator |
| Production's maintenance page is up                       | the off-box watcher                         | the owner and the second operator |
| Backup, restore drill, forwarder or worker heartbeat late | the off-box watcher                         | the owner and the second operator |
| The error sink not answering                              | the off-box watcher (one sink, both places) | the owner and the second operator |
| An app error on production                                | the error sink, from production's forwarder | the owner and the second operator |
| Failed sign-ins, refusals, permission changes, downloads  | the error sink, from production's forwarder | the owner and the second operator |
| A failed secret scan                                      | the error sink, from the scan itself        | the owner and the second operator |

Nothing here sets up the watcher or the sink. With `OPS_WATCH_PRODUCTION_URL`
set, `node scripts/ops/alerts.mjs plan` prints production's checks, their
alert words and the recipients; the operator adds each one by hand in the
watcher and in the sink. For a proof, `plan --test` prints the agreed test
address as the only recipient, to enter in place of the operators'.

The operations view links the error sink once `OPS_ERROR_SINK_URL` is set on
production's Vercel project. It holds the sink's web address and no secret.
Setting it takes one daylight redeploy. Delivery is proved only by mail
arriving: `node scripts/ops/alerts.mjs test`, run with production's forwarder
settings, raises one test alert through the sink, and a planted health failure
proves the watcher.

## The promotion step

`scripts/ops/promote.mjs` predates the Vercel plan. A real run stops and
starts an API and an auth server on the machine, and swaps a served link.
Production's API and sign-in are not on the machine, so production does not
use it. CI still runs its dry run.
