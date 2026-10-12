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

## The web deploy

```sh
node scripts/ops/web-deploy.mjs --version <id> --artefacts <store> --production
```

The same operator gate, stored build output, digest checks, sign-in server
version and Vercel read-back as staging's deploy apply. `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` name production's Vercel project. The one check left out
is staging's made-up-only preflight. A database that holds real sign-ins never
passes it.

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
maintenance page on production's address.

## The M5 unit

`compose.json` here is production's unit on the M5: the worker and its
forwarder, the backup store, and the two egress hops. It is staging's
definition with only the names changed (`tests/ci/production-unit.test.ts`
proves it). Everything production owns is named `ops-astro-*`, and every
credential is a `${PRODUCTION_*}` placeholder. So staging's containment,
limits, image pins and egress allow-list hold for production too: see
[Containment and limits](../staging/README.md#containment-and-limits). The
worker and forwarder containers are `ops-astro-worker` and
`ops-astro-forwarder`, the pair `scripts/ops/stop-production.mjs` stops.

```sh
node scripts/ops/deploy.mjs --version <id> --artefacts <store> --production
```

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

## The promotion step

`scripts/ops/promote.mjs` predates the Vercel plan. A real run stops and
starts an API and an auth server on the machine, and swaps a served link.
Production's API and sign-in are not on the machine, so production does not
use it. CI still runs its dry run.
