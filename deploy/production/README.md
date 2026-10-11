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

## The promotion step

`scripts/ops/promote.mjs` predates the Vercel plan. A real run stops and
starts an API and an auth server on the machine, and swaps a served link.
Production's API and sign-in are not on the machine, so production does not
use it. CI still runs its dry run.
