<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The local slice's data layer

The real Postgres the working slice runs on, the schema it carries, and how to
start, migrate, seed and prove it. It is local only. Nothing here is a
deployment, and nothing here is the Hub's `supabase_*` database or the draft's.

## Owned resources

| Thing     | Identity                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Container | `ops-astro-local-pg`                                                                                              |
| Image     | `postgres@sha256:b0f9560…2b24`, Postgres 17, the digest pinned in [supply-chain-pins.md](../supply-chain-pins.md) |
| Address   | `127.0.0.1:54390`                                                                                                 |
| Volume    | `ops-astro-local-pgdata-17`, mounted at `/var/lib/postgresql/data`                                                |
| Database  | `ops_astro_local`                                                                                                 |

The local database runs the hosted database's major, 17 (S0-7). Its volume is
named for the major because a cluster one major wrote, the other refuses to
open. A tree from before S0-7 ran 18 on `ops-astro-local-pgdata`, mounted at
`/var/lib/postgresql`; `db-up.sh` replaces that container, starts an empty 17
cluster on the new volume and leaves the old volume as it was. Migrate and
seed again after the switch.

## Roles, and the two URLs

`scripts/local/db-up.sh` writes both into `.local/db.env`, which is gitignored.

- `DATABASE_ADMIN_URL` is the owner. The migrations, the seed and the test
  harness use it, and the harness creates a throwaway database per run.
- `DATABASE_URL` is the runtime role `app`, a member of the group role
  `ops_astro_app` that the migrations grant to. It owns nothing, may create
  nothing, not even a temporary table in `pg_temp`, and cannot bypass row
  security.

With two roles, the server refuses runtime DDL, so no convention has to forbid
it. `force row level security` is then the barrier itself, not the last line of
one.

## Commands

Node 24 must be on the path, as [the slice's prerequisites](README.md#prerequisites)
state; the major is pinned in `.nvmrc`.

```sh
bash scripts/local/db-up.sh      # start it; idempotent; writes .local/db.env
node scripts/db-migrate.mjs      # apply every migration in migrations/, in order, once each
node scripts/local-seed.mjs      # people and grants (new database: LOCAL_SEED_MADE_UP=confirm)
bash scripts/local/db-down.sh    # stop the container; the volume is untouched

set -a; . ./.local/db.env; set +a
pnpm exec vitest run             # the whole suite, against this server
```

`db-down.sh` never removes the volume. To delete the data, run
`docker rm -f ops-astro-local-pg && docker volume rm ops-astro-local-pgdata-17`.

## Upgrade

The supported upgrade is the application stopped while it runs: stop the API
and GoTrue, run `node scripts/db-migrate.mjs` (`pnpm db:migrate`), then start
GoTrue and the API again. [README.md, "Start it"](README.md#start-it) has the
commands. A migration run beside a live application can go wrong in ways
no single migration can rule out. 0030 alone had two (SOL-R3R-1 and
SOL-R3R2-1), so the runner checks the rule rather than leaving it to this page,
within the limit below.

When at least one migration is pending, the runner
(`packages/core-records/src/tenancy/migrate.ts`) reads `pg_stat_activity` for
every client backend on its own database except its own
(`datname = current_database()`, `backend_type = 'client backend'`,
`pid <> pg_backend_pid()`). If it finds any, it throws `MigrationRefused`,
which names each one by pid, login, application name, client address and
start time. It has applied nothing and written no ledger row. The CLI prints
the same and exits 2. It counts any client session: the application login, GoTrue
(which connects as `postgres` on the local install), a `psql` you left open, another tool. None of
them can be told apart from an application safely, and there is no flag or
environment variable that skips the check. The one exception is hosted
Supabase's own services, which never stop: sessions whose login is exactly
`authenticator`, `pgbouncer`, `supabase_admin`, `supabase_auth_admin` or
`supabase_storage_admin` are left out of the count, so on hosted Supabase it
does not see Data API, Auth, Storage or Realtime traffic, and none of those roles exists on
the local install. With nothing pending it does not
look at all, so an up-to-date install with the application running passes.
The runner's role must be able to read every session in `pg_stat_activity`:
a superuser, as `DATABASE_ADMIN_URL` is on the local install, or a member of
`pg_read_all_stats`. PostgreSQL hides another role's `backend_type` from any
other role, so a role without that would find nobody connected. With a
migration pending, the runner refuses such a role (`MigrationRoleCannotSee`)
and names the grant it needs, and the CLI exits 2.

One run is one transaction. Every pending file's statements run in order,
each file's ledger row is written after its statements, and there is one
commit at the end, so a refused or failed run leaves the database at the
version it started at (SOL-FR6-2). A failed statement's error says so and
names that version, the last one in the ledger. Where a migration's header says a failing install "stays
at" the version before it, that means the version the run started at, which
is earlier when the run held several files. A file holding a statement
PostgreSQL will not run inside a transaction block, or one that would end the
transaction, is refused before anything runs (`OUTSIDE_A_TRANSACTION` in
`migrate.ts`). That covers every `CONCURRENTLY` index form and
`DETACH PARTITION ... CONCURRENTLY`, `VACUUM`, `DISCARD ALL`, `ALTER SYSTEM`,
database, tablespace and subscription commands, and
`ALTER DATABASE ... SET TABLESPACE`. It also covers every `REINDEX` and
`CLUSTER`, because PostgreSQL refuses them on a partitioned relation and the
text cannot say which relations are. Transaction control (`BEGIN`, `COMMIT`,
`SAVEPOINT`, `PREPARE TRANSACTION` and the rest) is refused too.
`ALTER TYPE ... ADD VALUE` is not refused: PostgreSQL runs it inside a
transaction block. A use of the new value later in the same run fails, and
rolls the run back whole, when the enum type was committed before the run, as
on every upgrade. When the type was created earlier in the same run, as on a
fresh install, the use succeeds, so a fresh-install gate cannot catch it. Ship
an `ADD VALUE` and its first use in different releases. The guard reads a
statement with the same scanner that splits the files, and that scanner reads
comments, strings, identifiers and numbers as PostgreSQL 18's lexer (`scan.l`)
does. So a nested block comment cannot hide a `COMMIT` (SOL-FR7-1), nor can
`$$` at the end of an identifier or the last `e` of a word read as an `E''`
prefix (SOL-FR9-1), nor a line comment that a lone carriage return ends, nor
an `E''` string continued on the next line (FR11-SCANNER). A word inside a
comment or a quoted string is not read as part of the statement. A piece that
is more than comments and whitespace is sent, never dropped, and so is one that
ends inside a block comment, so PostgreSQL refuses what it cannot read. None of the files on disk holds one of these.
Behind the guard, the runner sends each statement over the extended query
protocol, so if a statement the scanner read as one still holds two commands,
PostgreSQL refuses it ("cannot insert multiple commands into a prepared
statement") and the run rolls back whole (`oneCommandEach` in
`tenancy/database.ts`). After each statement the runner also asks the server
for its transaction's id. If it has changed, a statement ended the run's
transaction, so the runner stops at once and says which file and statement
did it, and that work before it in the run may be committed. That error never
says nothing was applied.

A session can connect after that first look. So the runner looks again inside
the transaction, before each file's first statement and once more after the
last ledger row, just before commit. It clears the backend's statistics
snapshot first, because otherwise a later look inside one transaction would
repeat the first. A session caught there refuses the run, and the whole run
rolls back. That leaves one window: a session that connects after the look
before commit and before the commit completes. It can begin a transaction
against the old schema and carry on after the commit, which a session that
connects afterwards cannot; a migration that needs to rule that out takes its
locks before its checks, as 0030 does. A run of many files also holds its
locks until the one commit, so an application that is somehow still up waits
longer. Nothing changes the database's `ALLOW_CONNECTIONS` or `CONNECTION
LIMIT` to close that window, because a crash between setting it and restoring
it would leave the install refusing its own application.

**The check cannot tell a stopped application from an idle one.** The API's
pool (`postgres`, `tenancy/database.ts`) opens a connection when a query needs
one, and an idle API or GoTrue may hold none between requests. A live drill on
the local install saw none from a running, healthy API and GoTrue, and one from
the API right after a request to `/api/health`. So an idle application passes
the check, and reconnects on its next request, on whichever schema is there by
then. Stopping the API and GoTrue is the operator's step, as README.md's
upgrade steps give it, and a script that upgrades must stop them itself before
`db:migrate`; the runner's check is a backstop, not the stop.

`tests/tenancy/migration-runner-guard.test.ts` holds real sessions open against
databases at 0023 and at the head. It covers the refusal with the application
login held, with other client sessions held, the ledger and schema unchanged
after it, the apply once they close, an up-to-date install with the
application connected, a session that arrives inside a migration, a session
that arrives during the second of two pending files and a failure in the
second of two (neither leaves the first), the refusal of each statement the
transaction cannot hold, and the CLI.
The test harness's `closeSessions()` ends its own application pool before a
test migrates. Nothing in the runner has a bypass.

## What the schema is

`migrations/` is the authority. It holds every migration from `0001_tenancy`
onward, `db-migrate.mjs` applies whatever is in it in order, and the prefix
harness below reads the same directory. No number here says which migration is
the last one, because the next migration would make it wrong.
`tests/tenancy/tenancy-conformance.test.ts`,
`tests/tenancy/restricted-calls-prefixes.test.ts` and
`tests/tenancy/restricted-calls.test.ts` all read the list from `migrations/`,
so a new migration edits none of them.

A migration is `migrations/<id>_<name>.sql`, a regular file, the name lower
case, digits and underscores. A new migration's ID is the UTC time it was
written, to the second, as fourteen digits starting `20`:
`20261002013000_task_labels.sql` for 01:30:00 UTC on 2 October 2026. Lanes
writing migrations at once then pick different IDs without asking each other.
The migrations written before that, `0001` up to the last four-digit one, keep
their numbers: an applied migration is never renamed. Every four-digit ID sorts
before every timestamp, and the four-digit range has no gap. Until the first
timestamp is on `main`, the check below also passes a new four-digit ID that
leaves no gap; after it, a four-digit ID sorts before `main`'s newest and is
refused.

Two places hold the rule (`packages/core-records/src/tenancy/migration-ids.ts`).
The runner refuses a directory holding a malformed `.sql` name, one that is not
a regular file, or one ID twice. The `commit messages and provenance` check
(`scripts/migration-ids.mjs`) runs on a pull request and again in the merge
queue. It judges every commit on the first-parent line from the base to the
head against that commit's own first parent, and the head against the base as
a whole: a pull request's merge with `main` as it stood when GitHub built the
merge, and in the queue, the run that holds, each entry against `main` and the
entries queued ahead of it. It refuses a duplicate ID, a migration that sorts
before the newest one already there, a gap in the four-digit range, a file that
is not a regular, non-executable file, a name ending in an upper-case `.SQL`
(a Mac checkout folds it onto the `.sql` of the same name), and a timestamp
more than an hour ahead of the clock (local time written as UTC). A migration not yet on `main` that fails it takes
a new timestamp; one on `main` is never renamed. The runner itself still
applies whatever is pending, in ID order, even below its ledger's newest, and
nothing checks a push to `main` that bypasses the queue: a database that ran a
migration before it reached `main` is out of step.

The upgrade drill (`pnpm verify:upgrade-drill`) fails a migration that changes a
row an installation already holds. A migration that does so on purpose, such as
a slot reservation or a field's owners, says so in
`migrations/<version>.changes.json`, beside the file: a list of
`{ "table", "columns", "where" }`. The drill excuses a changed row only where
that predicate picked it before the upgrade and the row differs in those columns
alone, and it fails a declaration whose change never happened
(`scripts/local/upgrade-drill-changes.mjs`). Every other reader of `migrations/`
reads `.sql` files only.

The first seven, `0001_tenancy` to `0007_command_envelope`, are the tenancy,
identity, grant, record and command-envelope spine ported from
`ops-astro-t1-draft@60f2009`. Two companion files describe the later ones.
[AUTHORITY.md](AUTHORITY.md) covers the agent-authority, settings and
delegation migrations, and [RUNTIME.md](RUNTIME.md) covers the proposal, gate,
decision, budget, lease and attempt migrations, and the model-call ledger and
copy register (`0085_model_calls`), and the pinned instruction files
(`0086_bootstrap_pins`), the budget wait (`0087_budget_wait`), its answers
(`0088_budget_answers`) and the diagnostic trace export (`0089_trace_export`, and `0090_trace_export_horizon`,
which stamps each run event with its writing transaction's id).
Read `ls migrations/` for the current set.

There is no `tasks` table. A task is a record of the built-in `task` record
type in fixed typed slots, and the slots are the acceptance checklist's field
table exactly:

| Field               | Slot                 | Written by                                                     |
| ------------------- | -------------------- | -------------------------------------------------------------- |
| `state`             | `uuid_1`             | `task.start`, `task.complete`, `task.reopen`, `task.set_state` |
| `assignee`          | `uuid_2`             | `task.assign`                                                  |
| `title`             | `txt_4`              | `task.update`                                                  |
| `description`       | unslotted, in `data` | `task.update`                                                  |
| `agent_brief`       | unslotted, in `data` | `task.update` (0076, MP-4-7)                                   |
| `page_link`         | unslotted, in `data` | `task.update` (0079, MP-4-12)                                  |
| `estimated_minutes` | unslotted, in `data` | `task.update` (0080, MP-4-8)                                   |
| `category`          | unslotted, in `data` | `task.set_category` (0084, MP-4-8)                             |
| `agent`             | unslotted, in `data` | `task.assign` (0082, Assign to AI)                             |
| `due`               | `ts_1`               | `task.update`                                                  |
| `priority`          | `num_1`              | `task.update`                                                  |
| `completed_at`      | `ts_2`               | derived on complete, cleared on reopen                         |
| `stage`             | `txt_5`              | `task.set_stage`                                               |
| `impact`            | `num_3`              | `task.set_scores`                                              |
| `confidence`        | `num_4`              | `task.set_scores`                                              |
| `ease`              | `num_5`              | `task.set_scores`                                              |
| `ad_hoc`            | `bool_2`             | `task.set_adhoc`                                               |
| `archived_at`       | unslotted, in `data` | derived on complete, cleared on reopen                         |
| `archived_why`      | unslotted, in `data` | derived on complete, cleared on reopen                         |
| `key`, `source`     | `txt_1`, `txt_2`     | system                                                         |

There is no `status` column and no second coarse field. Whether a task is done
is the machine category of the state record the task points at.

A task made by `task.duplicate` (MP-4-8) records where it came from as a row of
`record_links` with `link_type` `duplicated_from`, from the new task to the old
one. No field of the old task is copied beyond its type: the new task holds
only the title, client and step names the person sent. `task.read` shows the
link's target only to a reader who holds read on the old task.

A task's tags are not a field. The business's vocabulary is `tags` (one name
per business whatever its case, a unique index on the lower-cased name) and
the tags a task carries are rows of `task_tags`, keyed by the task and the
tag (0081, MP-4-11): written by `tag.create`, `task.add_tag` and
`task.remove_tag`, read on `task.read` and by `tag.list`.

A new task ranks after the last of its siblings: the tasks under its parent,
or for a top-level task the tasks on its board with no parent. Trashed siblings
count, because a trashed task keeps its rank and a restore brings it back, so a
restore does not tie with a task made while it was away (`rankAfterSiblings`,
`packages/core-records/src/tasks/placement.ts`).

Every field carries a write mode, slotted or not. The conformance check names
each field with a null write mode (`every field has a non-null write mode`,
`packages/core-records/src/records/conformance.ts`).

## What the tenancy proofs are

The suites under `tests/tenancy/` each run against a database of their own,
migrated from empty: a copy of the one database the run migrated from empty
(`tests/support/migrated-template.ts`), or migrated by the suite itself where it
asks to be (`fromEmpty`, or `OPS_ASTRO_DB_TEMPLATE=off` for all of them). With `DATABASE_URL` unset they print that nothing ran
instead of showing a green tick, and `scripts/db-conformance.mjs` fails any run
in which a named suite skipped.

| Suite                               | What it holds                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `statement-log.test.ts`             | The reading of SQL the no-DDL law depends on: quoting, dollar quoting, comments.                     |
| `tenancy-conformance.test.ts`       | The catalogue rules and the composite-key linter, every one of them broken on purpose and caught.    |
| `tenancy-wrapper.test.ts`           | The barrier between two businesses on the wrapper itself.                                            |
| `wrapper-mutation.test.ts`          | T04 and T05 as named mutations of the wrapper, on a disposable source copy, beside the restored run. |
| `pooled-crossover.test.ts`          | A→B on one physical backend.                                                                         |
| `migration-prefixes.test.ts`        | Every rule after every migration prefix, with three separated roles.                                 |
| `runtime-statements.test.ts`        | What six real task commands and reads send. It makes no coverage claim.                              |
| `statement-capture-full.test.ts`    | T04 and M03 over every operation in `COMMAND_SURFACE`, a positive call and a refusal each.           |
| `restricted-calls.test.ts`          | I06 and M02 at the full schema: every table and function called by each restricted role.             |
| `restricted-calls-prefixes.test.ts` | The same calls at every migration prefix, through `proveEachPrefix`.                                 |
| `production-lookup.test.ts`         | I14 on the shipped `lockTask`: the tenant predicate and the forced policy, each removed.             |

`statement-capture-full.test.ts` reads its operation list from the registry, so
an operation added without a case fails. Each call runs on a logged `max: 1`
runtime connection and must be one transaction. Its first statement sets the
business locally, and it must carry no session-wide setting, no DDL, an audit
row, and the work savepoint released on success or rolled back on refusal
(`statement-capture-cases.ts` is its harness, not a suite). The runtime
connection sends one statement outside a transaction: the `postgres` driver's
per-connection lookup of array types in `pg_type` (`fetch_types`), which the
suite asserts exactly (`DRIVER_TYPE_LOOKUP` in `statement-capture-cases.ts`).
Turning `fetch_types` off in `tenancy/database.ts` would remove it, but nobody
has made that product decision. Every logged connection starts with
`standard_conforming_strings` on, and the wrapper owns the setting: whatever a
connection URL says about it, in any case and with any value or none, every
connection's startup packet carries exactly `standard_conforming_strings=on`
(SOL-FR11B-1, SOL-FR11D-1). A change of it away from `on` that the server
reports, by SET, SET LOCAL, `set_config` or a function body, is recorded as an
opaque entry, so the log cannot be cleared past a point where it would misread
a string (FR11-SCANNER-2, SOL-FR11-2).

The restricted-calls suites call as the application login (inside and outside
the wrapper, own and other tenant), the application group, an outsider,
`ops_astro_worker` and the owner. They assert each answer by SQLSTATE and check
that the table's contents are unchanged after every write. The full-schema
suite runs on the acceptance world, walked through the real application to a
handback, so the other-tenant cases filter rows that exist. The expected grants
are `APPLICATION_GRANTS` in `restricted-calls-cases.ts`, which is a harness,
not a suite. A new table fails both suites until its grant row is added there.
A BEFORE ROW insert trigger answers before row security's WITH CHECK, so a
foreign insert into `delegations` is refused with `check_violation`
(`BEFORE_ROW_REFUSALS`). `handback_reports_append_only` is `security definer`
(migration 0018), but no application role reaches it: the group holds only
`select` and `insert` on `handback_reports`, so the privilege check refuses
`update` and `delete` before the trigger runs. Its only live caller is the owner,
whom it refuses. `model_route_room` (migration 0085, AW-01's fair share) is
the second, and the one read across businesses: a route's ceiling is the
installation's, which a tenant transaction cannot count under row security.
It answers one whole number, 1 when the transaction's own business may hold
one more call on the route and 0 when it may not, with no id and no count; a
provider lookup's unexpired slot counts as a call (migration 20261004040000 replaces it,
keeping its grants and rights);
the business is `app_business_id()`, never an argument, and none is 0. It
runs with `row_security = off`, so an owner that does not bypass row security
is refused rather than answered from one business's rows. PUBLIC and the
application group may not execute it. Only `ops_astro_broker` may, a
`nologin` role that holds nothing else; the group may take it (`SET`) but does
not inherit it, so the broker takes it for the one statement with
`set_config('role', ..., true)` and gives it back. The suites sort that role
into a class of its own (`broker`). `tests/broker/aw-01-broker-fair-share.test.ts`
proves the separation and the grants. `take_lease` (migration 20261004040200, SL11-30) is
the third, and the one way a lease is written. The application group holds no
insert on `leases` and updates only `expires_at`, `state` and `released_at`, so
it can neither rewrite a lease's holder nor forge a lease, and 0111's check
that a reviewed output is its lease holder's work stands on the holder column.
Pickup calls it after its own checks under the locks. It checks again inside, in
`app_business_id()`'s business: the reservation is claimable, the approving
person is the one named, the claimant's authority is live (a person's own write
on the task, or an agent's own delegation for this lease from the approving
person, judged as `EFFECTIVE` judges grants), and the expiry is within a lease's
lifetime. It computes the fence itself. The application role still writes
delegations, grants, gate decisions and actors, so a new lease is only as
trustworthy as those rows; the delegation mint behind this path is the next step. It runs as its own
role, `ops_astro_lease_path` (no login, no bypass, not the owner, and the
application group cannot set it), so row security and the made-up guard judge
its one insert as the application's; its search path is `pg_catalog, pg_temp`, PUBLIC may not execute it, and a call naming
nothing answers null. `tests/db/take-lease-path.test.ts` and
`tests/db/lease-holder-guard.test.ts` prove it.

`ops_astro_occurrence` (migration 0097, AW-01 J) follows the same pattern
without a function: it holds `insert` on `planned_runs`, `select` on a task's
`business_id`, `id` and `revision` (for 0032's trigger), the columns of
`live_changes` that 0035's trigger upserts as the inserting role (insert of the
task's key, update of the stamp, a read of both; no delete) and execute on
`app_business_id()`, and nothing else. The worker's occurrence path takes it
for the one insert of an occurrence's run; the trigger
`planned_runs_occurrence_origin` refuses an origin written by any other role
and any later change to one. The suites sort it into a class of its own
(`occurrence`), and the column-grant contract names each of its column grants.

At every migration prefix, every tenant table holds an owner-written row per
business before the calls, so cross-tenant reads are asked of rows that exist
(the header of `restricted-calls-prefixes.test.ts`, and its
`answers every caller as the contract says after <version>`). At the full
schema, the suite seeds `person_identifiers`, `person_merges`, `record_links`
and the three `inbox_` tables itself. The suite counts the own-tenant insert
positive control (TC:108) per table: one insert through the production wrapper on each tenant table the
application may insert into, each `rows 1`, and each rolled back
(`restricted-calls.test.ts`,
`admits an own-business insert on every table the application inserts into`).

I14's predicate-removed runs load `lockTask` and the command path from a
disposable copy of `packages/core-records/src` and `packages/core-runtime/src`
under the ignored `.local/mutants/`, with the one `TENANT_PREDICATE` line
replaced (`tests/support/source-mutant.ts`). The shipped module has no setter,
and the replacement must match exactly once or the load fails.

### The pooled crossover

The wrapper suite drives a handle itself, which is not the pooled failure. In
the pooled failure, A's operation finishes, the pool hands the same backend to
B, and something A left on the session is still there. Asking inside B's
transaction cannot answer it, because B's own `SET LOCAL` overwrites whatever
was left before B can read it.

So `pooled-crossover.test.ts` runs two real `task.create` commands over one
pool of size 1, records `pg_backend_pid()` at every step and asserts a single
backend, and reads the connection between the transactions through
`connectObserved`. That factory is the only supported way onto a pooled
connection outside the wrapper, and it exists for this proof. `connect`, which
the application gets, has no such way in.

With the wrapper's `set_config` `is_local` argument temporarily `false`, the
mutation showed three things. The setting survives A's commit, a no-setting read
on the reused backend returns A's rows, and the setting is still A's after a
rollback. It did not show B reading A's row, because B's own setup overwrites
the session-wide value first. That case passes under the leak, so the proof
does not rest on it.

### The migration prefixes

Running the conformance set only against the end state misses real states.
Every installation passes through the state after `0001`, and an install
last upgraded at an older head stands in one of them. A run of the runner
cannot stop between two files, because it commits them together. So
`tests/support/prefix-harness.ts` applies the
migrations one at a time and, after each, runs the tenancy catalogue, the
composite-key linter and the default-deny set in
`packages/core-records/src/tenancy/privileges.ts`.

Three roles, separated: the owner builds, `ops_astro_app` is granted what the
migrations grant it, and a third login that is a member of nothing stands for
every other role the cluster will ever have. It connects, so its refusals are
the server's.

Default deny is nothing granted to `PUBLIC`, nothing reachable by a role
outside the group, no `CREATE` on any schema, no `TRUNCATE` for the application
role, and no superuser or `bypassrls`. `TRUNCATE` is on the list because row
security does not filter it: a role holding it empties every tenant's rows
without consulting a policy. There is also no `TEMPORARY` on the database for
`PUBLIC`, the group or any login (`defaultDenyConformance`). PostgreSQL grants
it to `PUBLIC` on every new database, and a temporary table outlives the
transaction on a pooled backend, where the next tenant's unqualified `records`
finds it before `public.records`, with no row security. So
`createEmptyDatabase` (`tests/support/fresh-database.ts`), which makes each
test database, and `scripts/local/db-up.sh` revoke it where they make the
database (`tests/tenancy/temporary-tables.test.ts`). Since migration
0031 the migrations revoke it too, on the current database, from `PUBLIC`, the
group and every login in it, so a database made before that revoke loses it
when it is migrated (`migrations/0031_upgrade_guards.sql`;
`tests/runtime/upgrade-guards.test.ts`). A backend that had
already made a temporary table keeps it until it disconnects, so restart the
API after migrating. The harness also
names the schemas it found, so
"is storage denied?" gets a catalogue answer. This tree has `ops` and `public`
and no `storage` schema, which is an absence, not a denial.

A new migration extends the proof by itself. The harness reads the prefixes
from `migrations/`, with no list here, in the suite or in a manifest. Add a
`migrations/<UTC timestamp>_*.sql` (see "What the schema is") and it is covered.

## What a write is checked against

Two rules, both in `packages/core-commands/src/commands/prepare.ts`. A rule held
in one handler is a rule the next handler forgets.

**The target is locked before its revision is compared.** A targeted write reads
its record `for update` and only then compares `expectedRevision`. Without the
lock, two writes presenting the same revision each read the record as it stood
before the other's uncommitted write, and both passed the comparison. The second
then restored what the first had replaced and still told its caller `applied`.
With the lock, the second waits, re-reads the committed revision and is refused
`VERSION_STALE`. A declaration with `targetLock: 'runtime'` (`task.propose`) is
the one exception. `prepareCommand` only reads that task, because the runtime
takes its own locks in its own order, and the handler compares the revision once
it holds them.

**The authority target comes from the declaration, not the body.** Each
declaration's `authorisedOn` names it (`CommandDeclaration` in
`core-wire/src/surface.ts`). `record` is checked against the task named in
`recordId`. That is every command with `targetsExistingRecord`, plus
`task.cancel` and `task.restart`, which name their task without writing it.
`target` is checked at the scope of the grant or delegation being revoked
(`grant.revoke`, `delegation.revoke`; `SCOPE_OF.target` in `prepare.ts`). `claim`
is checked against the task that the body's reservation or lease belongs to
(`task.pickup`, `task.handback`, `task.heartbeat`; `SCOPE_OF.claim`). Every other
command is checked against the business, whatever identifiers its body carries.
Reads declare it too. `task.read` is `record`. It asks about the task once
`reads/dispatch.ts` resolves it, and about the business when it does not. Every
other read is `business`. The read path decides from its catalogue row, and
`tests/commands/read-authorised-on.test.ts` holds the declaration to it.
Deriving the scope from `request.recordId` instead let a record-scoped grant
turn a refused `task.create` into an accepted one by naming the record it did
hold. An untargeted command that carries an identifier it has no use for is
now refused `COMMAND_BODY_INVALID` naming the field (`refuseIrrelevantTarget`).
If the server silently dropped the identifier, the caller would believe it had
been honoured.

### A setting is checked against its revision

`business_settings` is not a record, so `prepare.ts` does not reach it, but the
same rule applies. Migration `0020_business_settings_revision.sql` gives the
table `revision integer not null default 1` with a check that it is at least 1.
The default upgrades an installation that already had settings. Every existing
row starts at 1, so no reader ever meets a null revision.

The revision moves in one place. `writeBusinessSetting`
(`packages/core-records/src/records/business-settings.ts`) reads the row
`for update`, compares the caller's `expectedRevision` when one is sent, and
then writes the value and `revision = revision + 1` in one statement, so the
row never holds a new value at an old revision. A mismatch is refused
`VERSION_STALE` naming `revision=<current>`, and the value is left as it was.
Both settings commands write through it (`commands/settings-write.ts`), so
every command write moves the revision by exactly one, and `settings.read`
hands the current number back.

There is no trigger, unlike `records.revision`. The migration's header says
why: a trigger would bump the revision for every writer of the table, fixtures
and migrations included. So a statement that updates `business_settings`
without going through `writeBusinessSetting` leaves the revision where it was.
On this head nothing in `packages/` does. [AUTHORITY.md](AUTHORITY.md#business-settings)
has the interface and the tests.

## The reads

Nine reads are declared in `COMMAND_SURFACE` with `kind: 'read'` and served by
`packages/core-commands/src/reads/`. Four of them are this file's:

- `task.read { recordId }` → the task, its state, its assignee and its history
- `task.board { board }` → the tasks on a board that the caller's grants
  reach, and, for a collection-wide reader only, `withheld`, how many others
  there are; `null` is the unboarded
  ones, which is where a task created without a board lives
- `person.list {}` → the people with an active membership, which is the set
  `task.assign` will accept
- `tag.list {}` → the business's tag vocabulary, by name (MP-4-11), for a
  reader of the business's tasks
- `task.todos {}` → the reader's own open tasks on any board, with their tags
  and the client messages owed a reply (MP-7-1), for a reader of the
  business's tasks; `{ person }` a teammate's, `{ client }`
  every one under that client (MP-7-2), under the same key
- `team.list {}` → the staff with an active membership and each one's
  availability (`person_availability`, 0066, set only by that person), for the
  Team panel; a client of the business is answered `NOT_FOUND`

The other six, `task.queue`, `task.ledger`, `preset.plan`, `settings.read`,
`session.capabilities` and `access.read` (Settings ▸ Access, C32, under
`access:manage`), are listed with their answers under "Reads" in
[API.md](API.md#reads).

On the person prefix a read carries no `operation_id` and no
`expected_revision`: there is nothing to replay and nothing to be stale
against. On the agent prefix every call, reads included, carries an
`operation_id`, because the agent envelope refuses a call without one
(`runAgentCommand` in `packages/core-commands/src/commands/agent-envelope.ts`).
A person's read runs through `withSession` and the
same `checkAuthority` the commands use, in the same transaction, so a revoked
grant bites on the next read. A denied read is `SCOPE_NOT_GRANTED` and never an
empty list.

An external party reads through the same path with no membership. Its share is
an ordinary `grants` row at `scope_kind = 'record'`, so it needed no migration,
and `task.read` answers it `sharedTask` rather than the task
([AUTHORITY.md, "The external party"](AUTHORITY.md#the-external-party-r4)).

## The seed

`scripts/local-seed.mjs` creates businesses `alpha` and `bravo`, the five
identities the slice contract names, their `logins` on provider `supabase`,
memberships and grants. It also installs each business's task spine and
business settings, enrols one agent login per business with a budget cap
(recorded in `.local/synthetic-agents.json`), and creates `.local/gate.env` and
`.local/delegation.env` once, reading them back on every later run. It is
idempotent by lookup: a second run finds every row and inserts none. One
exception brings an earlier install forward: on a business whose task type
already exists, the installer sets `title` and `state` to their declared
visibility class (`shared`, I09) where they differ, so a reseed shows a client
those two fields on a business installed before 035967b (`reconcileVisibility`,
`tasks/install.ts`). It changes no other field row and no record.
`tests/tasks/install-visibility-upgrade.test.ts` pins that a second run writes
nothing by `xmin` and `ctid`, because `field_defs` has no revision column and a
same-transaction update leaves `xmin` unchanged.

It never seeds a task. Nobody would have created a seeded task, and it would
make every acceptance case pass without the product working.

Two identities carry negative cases:

- `noah@alpha.local` is a real member of A with no grants, for "an
  authenticated member without task collection scope" (N2).
- `orphan@alpha.local` is a verified login with no mapping and no membership,
  for `AUTH_NO_MEMBERSHIP` (N2's second half).

The seed enrols one external party (R4). It adds an entry with
`role: 'external'` to `.local/synthetic-users.json`, creates its GoTrue user,
and gives it a login and an acting identity with no membership and no business
grant (`scripts/local-seed.mjs`, `ensureExternalEntry` and `seedAgentUser`).
It shares a task with it only when rerun with `LOCAL_SEED_SHARE_TASK` naming a
task by key or id, through `shareRecord` under the admin's own `share` grant
(`shareWithExternal`). The tests make their own external party with
`tests/acceptance/world.ts`'s `enrolExternal`.

**Carry the existing external entry and agents file before seeding against a
shared GoTrue.** The seed sets the password of a GoTrue user it finds already
there, the agents' and the external party's, to the one its file holds
(`seedAgentUser`), so the credential it writes signs in. When
`.local/synthetic-users.json` has no `role: 'external'` entry, or
`.local/synthetic-agents.json` is absent, it writes new passwords
(`ensureExternalEntry`, `readAgents`). Against a GoTrue that other checkouts
also use, that resets those passwords for all of them. Copy the existing entry
and file in first.

Before it reads or writes anything, the seed refuses a `GOTRUE_URL` that is
neither https nor this machine, since the admin API's key goes with every call.
Once the admin connection's database is admitted as made-up, it refuses a
`DATABASE_URL` that does not reach that same database: the admin connection
holds a lock under a random key, and the application connection must see it
in `pg_locks` for its own database.

Identity comes from `.local/synthetic-users.json`, which `auth:seed`
(`scripts/local/auth-seed.mjs`) writes because the GoTrue subjects are its to
mint. Until that file exists the seed writes a placeholder with random subjects
and says on every run that those identities cannot sign in.

## Second factors (0049, C59)

`second_factors` records that a person has a second factor at the sign-in
provider, which one (the provider's factor id, a bounded identifier, never a
secret) and where it stands: `unverified` from enrolment until the first code
completes it, `verified`, then `removed` when it is replaced or taken away.
One live factor per person (`second_factors_one_live`). The application may
select, insert and update; nothing deletes a row, so a person's factor history
stays readable. The authenticator secret and the codes a person types are
never written here. Whether a person has a verified factor is mirrored onto
`people.second_factor_verified` by the same writers in the same transaction
(`identity/second-factor.ts`), so login resolution reads it inside the one
query it already makes and refuses a sign-in without the second factor. It
reads the column through the row's json, so on a database from before 0049,
which has no such column, the answer is no factor. The same writers record
the verification and the removal by subject for every business (0064, below).

## Privacy incidents (0050, C55)

`privacy_incidents` holds the breach runbook's day-0 record: what happened,
when it was found (`found_at`, day 0), who found it, which clients and people
(`affected`), and the kinds of information from a closed list of seven. The
assessment limit is derived from `found_at` where the row is read, so no stored
date can drift from it. Status is `open` or `closed`. The application may
select, insert and update; nothing deletes a row. The table is tenancy-keyed
with the restrictive policy like every business table, and it is not a
`records` row, so no share, search or export reaches it. The audit chain and
the operation register hold a digest and the new row's id, never the words.

## Security alert log (0069, C55)

`ops.security_alert_log` holds each alert S0-2's forwarder raised, by its kind
and the database's time alone: no sink id, scope, business, client, person,
secret or record content. The forwarder writes it in the statement that keeps
the alert in `ops.api_alerts` (0048), so a pass that fails writes neither and
an alert kept already is not written twice; the send that deletes the
`ops.api_alerts` row leaves the log alone. The forwarder may insert the kind
column only. The application group may select `kind` and `at` only, and
changes nothing; it still holds nothing on `ops.api_alerts`. The table belongs
to no business, so the operations view reads it only for the business that
operates the installation (`ops.installation.operator_business_id`), newest
first, at most 50 (`operations/security-alerts.ts`).

## The last tested restore (0070, C55)

`ops.last_tested_restore` holds one row, the date of the last successful
tested restore, and nothing else: no business, person, archive, path or key.
It is installation state, like `ops.operating_business` (0045). The restore
drill writes it on a pass the backup store took, and only then
(`scripts/ops/drill-acts.mjs`), as `ops_astro_restore_drill`: a role no one
logs in as, which runs `ops.record_tested_restore()` and holds nothing else.
That function is a security definer with its search path pinned, takes no
argument and stamps the database's own time, never moving it back, so the
drill cannot name a date. The drill takes the role by name on the owner's
connection (`scripts/ops/tested-restore.ts`), as the business lookup takes
0046's. Where the owner's login is not a superuser (hosted Supabase holds
both with ADMIN OPTION alone), 20261005063514 grants it each of the two with
SET and without INHERIT: it may take them by name and holds nothing of
theirs otherwise. The application may select the row and nothing more;
PUBLIC holds nothing on the table or the function. `operations.read` serves it as
`lastTestedRestore` ([API.md](API.md)).

## Legal documents (0051, C81)

`legal_document_versions` holds every version of a business's legal documents:
the document, its `major.minor` label (one per document), the words, and
`body_digest`, the SHA-256 of the words, set by the database on insert. The
approval (`approved_at`, by whom, and the digest approved, which must equal
`body_digest`) and the publication are each set once. A guard refuses any
change to the drafted columns, and any change or clearing of an approval or a
publication once set, so a published version's bytes never change in place.
The application may select, insert and update; nothing deletes a row. The
table is tenancy-keyed with the restrictive policy. The audit chain and the
operation register hold a digest and the version's id, never the words.

## Clients (0055, C32)

`clients` holds one row per client of the business: its `name` (1 to 200
characters, trimmed, one per business in any letter case, `clients_one_name`)
and who made it and when. It is the party a party-scoped grant names in
`grants.scope_id` and a task names in its `client` link (`records.uuid_7`).
Neither carries a foreign key to it, so `access.grant` and `task.set_party`
check a client is of this business before writing its id. The application may
select and insert; nothing deletes a row. Tenancy-keyed with the restrictive
policy.

C60 (20261003000423) adds the client's privacy settings, each off for a new
client: `model_egress` with `model_providers` (on only with a provider named,
`clients_egress_names_providers`), `handles_health` (which keeps model egress
off, `clients_health_keeps_egress_off`) and `no_agent_edits`. The application
may update those four columns alone, by `client.set_privacy`.
`client_model_requests` keeps each written request for model use: who asked,
when, the link to the request, the providers and the outcome (`applied` or the
refusal's code), with who recorded it. Select and insert only; written once.
Tenancy-keyed with the restrictive policy.

## Access endings (0056, C58)

`access_endings` holds one row per login of a person whose access was ended
(`access.end`): who ended it and when, and the two provider steps it owed,
each stamped once when done (`sessions_ended_at`, `login_deactivated_at`).
`attempts`, `attempt_started_at` (a retry's 30-second claim) and `last_fault`
(the kind of the last failure, one of five words, never the provider's text)
record the retries. The application may select, insert and update; nothing
deletes a row. Tenancy-keyed with the restrictive policy. The partial index
`access_endings_owed` is what the server's retry looks for. `provider_steps_skipped` (0062) is `shared` where both steps were stamped done without a call because the subject was still live in another business.

## Ended sessions (0057, C58)

`authentication_attempts.session_id` is the provider session a resolved
attempt came in on (null on a refusal, and for a token that names none); a
person's session list reads it through `authentication_attempts_person_sessions`.
`ended_sessions` holds one row per session a person ended: signed out
(`sign_out`), ended from another session (`end_others`) or by a second-factor
change (`factor_change`). Unique on business, person and session. The
application may select and insert; nothing changes or deletes a row.
Tenancy-keyed with the restrictive policy.

## Ended provider sessions (0061, C58)

`ops.ended_provider_sessions` holds the id of every provider session ended
anywhere: each `ended_sessions` row, and the browser's sign-out at
`/api/session/end`, which names no business. Installation-wide, no business,
person or reason: the id alone. Login resolution refuses a token whose session
is here in every business, and a person's session list leaves it out. The
application may insert and read the id column; nothing changes or deletes a
row.

## Other sessions ended by subject (0063, C58)

`ops.ended_subject_sessions` holds one row per "end my other sessions" or
factor change: a SHA-256 digest of the login's subject, the session kept
(null keeps none) and when. Installation-wide, no business, person or
reason. Login resolution refuses a token of that subject whose session is not
the kept one and whose first sign-in is at or before the ending, allowing
the minute the provider's clock may run ahead (`SIGN_IN_CLOCK_SKEW_SECONDS`). The
ending's time is set as its transaction commits (20261004040300: a deferred
constraint trigger, a pinned security definer that only moves the new row's
time later), not when the transaction began. The
application may insert the digest and the kept session and read the three
columns; it changes and deletes nothing, and only that trigger changes a row.

## Second factors by subject (0064, C59)

`ops.second_factor_subjects` holds one row per second factor verified or
removed through any business: a SHA-256 digest of the login's subject, one of
the provider's factor id, and `verified` or `removed`. Installation-wide, no
business, person or reason. Login resolution refuses a sign-in below `aal2`
in every business the login reaches while one of its factors is verified and
not removed; a removed factor is never verified again, so the rows need no
order. Before 0064 the person's mirror alone answers. The application may
insert and read the three columns; nothing changes or deletes a row.

## Second-factor codes by subject (0072, C59)

`ops.second_factor_codes` holds one row when a second-factor code is sent to
the provider through any business, and one when it is answered other than
wrong: a SHA-256 digest of the login's subject, the attempt's random id (the
act's audit event carries it as its `operation_id`), `sent` or `answered`, and
when. Installation-wide, no business, person or reason. The factor routes
refuse `SECOND_FACTOR_LOCKED` while five codes sent in the last fifteen
minutes have no `answered` row, counted under a transaction-scoped lock on the
subject's digest. The application may insert the digest, the attempt and the
state and read the four columns; it changes and deletes nothing. The daily
upkeep job deletes rows recorded more than 24 hours ago, far past the window,
through `ops.expire_second_factor_codes()` (20261002105957): a security
definer with its search path pinned and no argument, run as `ops_astro_upkeep`,
a role no one logs in as that holds execute on it and nothing else. PUBLIC and the
application may not run it.

## Overseas-services register (0052, C81)

`overseas_services` holds one row per outside service that receives personal
information (SP-25): the service, what it receives, where it is stored
(`stored_where`), whether it trains on it, the contract, `to_confirm` and
`in_use`, with who changed it last and when. One row per service in any letter
case (`overseas_services_one_service`). The application may select, insert and
update; nothing deletes a row. Tenancy-keyed with the restrictive policy.

0052 also gives `legal_document_versions` two columns, `register` (the rows in
use as a JSON array) and `register_digest` (SHA-256 over those rows and their
`to_confirm` marks, in order). A privacy-policy version has both, and no other
document has either (`legal_document_versions_register_policy_only`). The
written-once guard now covers them with the rest of the draft.

## Data-class register (0053, C81)

`data_classes` holds one row per class of personal information: the class
(`data_class`), its purpose, its normal disclosures, its retention and its
deletion, each required by a check, with `in_use` and who changed it last and
when. One row per class in any letter case (`data_classes_one_class`). The
application may select, insert and update; nothing deletes a row.
Tenancy-keyed with the restrictive policy.

0053 also gives `legal_document_versions` `data_classes` (the classes in use
as a JSON array) and `data_classes_digest` (SHA-256 over their words, in
order). A privacy-policy version has both, and no other document has either
(`legal_document_versions_data_classes_policy_only`). The written-once guard
covers them with the rest of the draft.

## Agent credentials (0054, API-2)

`agent_credentials` holds one row per agent credential: the fresh agent actor
it is for (`agent_actor_id`, one credential per agent actor), the person and
actor who issued it, its purpose, its scope as `collection:action` keys (1 to
32, never decide, share or manage, by `agent_credentials_scope_shape`), the
SHA-256 of its secret (`credential_hash`), the scheme (`hmac-sha256-v1`) and
the key id, when it was issued and when it expires (after issue), and the
revocation (`revoked_at` with `revoked_by_actor_id`, both or neither). The
secret itself is stored nowhere. A guard keeps every issued column as written
and lets the revocation be set once. The application may select, insert and
update; nothing deletes a row. Tenancy-keyed with the restrictive policy.

## Automations (20261004091552, C33)

`automation_definitions` holds one skill or automation a business keeps (its
kind and name). `definition_versions` holds each release of one: the bytes
pinned by SHA-256 digest and size, the inputs and operations it declares, and
the activation modes it permits, numbered from 1 per definition. A version is
never changed or removed, the owner's update or delete included
(`definition_versions_immutable`). `activations` runs one definition in one
mode (`manual`, `scheduled` every 1 to 10,080 minutes, or `event` on a named
event kind), always pinned to one of that definition's versions, and refuses
a mode its pinned version does not permit (`activations_mode_permitted`, an
after trigger so row security answers another business first; an update that
keeps the mode and the pin is not asked again). `activation_occurrences` holds
each due time or event once (`activation_occurrences_due_once`,
`activation_occurrences_event_once`), with its outcome and a version of its
activation's own definition (`activation_occurrences_version_of_definition`),
and names a run only when it started one, at most one occurrence per run. Nothing here starts a run:
an occurrence is `activation_off` or `no_standing_approval` unless C52-A's
standing approval (below) lets it through as `approved`. The application may
select and insert all four, and update an activation's setting, pin, switch and
revision by column grant; nothing deletes a row. Tenancy-keyed with the
restrictive policy. The records are `packages/core-records/src/automations/`.

## Standing approvals (20261005184526, C52-A)

`standing_approvals` holds each adoption of an exact released version on an
activation (`adopted`, or `rolled_back` for a rollback), its definition, the
version pinned before it, the activation revision it wrote (`sequence`, unique
per activation) and the person who decided it. The version and the previous
one are of the activation's own definition (`standing_approvals_version_fkey`,
`standing_approvals_previous_fkey`). `activations.approval_id` names the
adoption that stands, which must be of the activation's own pin
(`activations_approval_fkey`); a before-update trigger
(`activations_approval_stands`) clears it when the pin, mode, schedule or
event changes or the activation is switched off, unless the same write names
the adoption that wrote this very revision, and refuses any other. A
revocation is its own row (`standing_approval_revocations`, once per
approval), and the approval stays. An occurrence that is `approved` names the
approval it saw (`activation_occurrences_approved_names_approval`, of the same
activation and version), and `occurrence_dispatches` records once per
occurrence what dispatch found under the activation's lock: `started` with its
run (unique per run), or `activation_off`, `approval_revoked` or
`approval_ended`. The application may select and insert the three tables and
update `activations.approval_id` by column grant; nothing changes or deletes an
approval, revocation or dispatch. Tenancy-keyed with the restrictive policy.
