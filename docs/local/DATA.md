<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The local slice's data layer

The real Postgres the working slice runs on, the schema it carries, and how to
start, migrate, seed and prove it. It is local only. Nothing here is a
deployment, and nothing here is the Hub's `supabase_*` database or the draft's.

## Owned resources

| Thing     | Identity                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Container | `ops-astro-local-pg`                                                                                  |
| Image     | `postgres@sha256:77f5851…a1873`, the digest pinned in [supply-chain-pins.md](../supply-chain-pins.md) |
| Address   | `127.0.0.1:54390`                                                                                     |
| Volume    | `ops-astro-local-pgdata`, mounted at `/var/lib/postgresql`                                            |
| Database  | `ops_astro_local`                                                                                     |

Postgres 18 keeps its cluster in a subdirectory of `/var/lib/postgresql`. Mount
the volume at `/var/lib/postgresql/data` instead and the server finds a cluster
in a directory it does not use, and refuses to start.

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
node scripts/local-seed.mjs      # businesses, people, logins, memberships, grants
bash scripts/local/db-down.sh    # stop the container; the volume is untouched

set -a; . ./.local/db.env; set +a
pnpm exec vitest run             # the whole suite, against this server
```

`db-down.sh` never removes the volume. To delete the data, run
`docker rm -f ops-astro-local-pg && docker volume rm ops-astro-local-pgdata`.

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
(which connects as `postgres`), a `psql` you left open, another tool. None of
them can be told apart from an application safely, and there is no flag or
environment variable that skips the check. With nothing pending it does not
look at all, so an up-to-date install with the application running passes.

A session can connect after that first look. So the runner looks again inside
each migration's transaction, before its first statement and again after its
ledger row, just before commit. It clears the backend's statistics snapshot
first, because otherwise the second look inside one transaction would repeat
the first. A session caught there rolls that migration back, and the error
names the ones that committed before it in the same run. That leaves one
window: a session that connects after the look before commit and before the
commit completes. It starts on the old schema or waits on the migration's
locks, and it is no worse off than a session that connects the moment after
the upgrade. Nothing changes the database's `ALLOW_CONNECTIONS` or `CONNECTION
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

`tests/tenancy/final-r6-runner-guard.test.ts` holds real sessions open against
databases at 0023 and at the head. It covers the refusal with the application
login held, with other client sessions held, the ledger and schema unchanged
after it, the apply once they close, an up-to-date install with the
application connected, a session that arrives inside a migration, and the CLI.
The test harness's `closeSessions()` ends its own application pool before a
test migrates. Nothing in the runner has a bypass.

`migrations/` is the authority. It holds every migration from `0001_tenancy`
onward, `db-migrate.mjs` applies whatever is in it in order, and the prefix
harness below reads the same directory. No number here says which migration is
the last one, because the next migration would make it wrong.
`tests/tenancy/tenancy-conformance.test.ts`,
`tests/tenancy/restricted-calls-prefixes.test.ts` and
`tests/tenancy/restricted-calls.test.ts` all read the list from `migrations/`,
so a new migration edits none of them.

The first seven, `0001_tenancy` to `0007_command_envelope`, are the tenancy,
identity, grant, record and command-envelope spine ported from
`ops-astro-t1-draft@60f2009`. Two companion files describe the later ones.
[AUTHORITY.md](AUTHORITY.md) covers the agent-authority, settings and
delegation migrations, and [RUNTIME.md](RUNTIME.md) covers the proposal, gate,
decision, budget, lease and attempt migrations. Read `ls migrations/` for the
current set.

There is no `tasks` table. A task is a record of the built-in `task` record
type in fixed typed slots, and the slots are the acceptance checklist's field
table exactly:

| Field           | Slot                 | Written by                                   |
| --------------- | -------------------- | -------------------------------------------- |
| `state`         | `uuid_1`             | `task.start`, `task.complete`, `task.reopen` |
| `assignee`      | `uuid_2`             | `task.assign`                                |
| `title`         | `txt_4`              | `task.update`                                |
| `description`   | unslotted, in `data` | `task.update`                                |
| `due`           | `ts_1`               | `task.update`                                |
| `priority`      | `num_1`              | `task.update`                                |
| `completed_at`  | `ts_2`               | derived on complete, cleared on reopen       |
| `stage`         | `txt_5`              | `task.set_stage`                             |
| `key`, `source` | `txt_1`, `txt_2`     | system                                       |

There is no `status` column and no second coarse field. Whether a task is done
is the machine category of the state record the task points at.

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
migrated from empty. With `DATABASE_URL` unset they print that nothing ran
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
has made that product decision.

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
whom it refuses.

At every migration prefix, every tenant table holds an owner-written row per
business before the calls, so cross-tenant reads are asked of rows that exist
(the header of `restricted-calls-prefixes.test.ts`, and its
`answers every caller as the contract says after <version>`). At the full
schema, the suite seeds `person_identifiers`, `person_merges` and `record_links`
itself. The suite counts the own-tenant insert positive control (TC:108) per
table: one insert through the production wrapper on each tenant table the
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
Every installation passes through the state after `0001`, and a deploy that
stops between two migrations leaves it in one of them. So
`packages/core-records/src/tenancy/testing/prefix-harness.ts` applies the
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
`createEmptyDatabase` (`tenancy/testing/fresh-database.ts`), which makes each
test database, and `scripts/local/db-up.sh` revoke it where they make the
database (`tests/tenancy/final-r2-fr2-api-temporary.test.ts`). Since migration
0031 the migrations revoke it too, on the current database, from `PUBLIC`, the
group and every login in it, so a database made before that revoke loses it
when it is migrated (`migrations/0031_upgrade_guards.sql`;
`tests/runtime/final-r2-dbtest-upgrade-guards.test.ts`). A backend that had
already made a temporary table keeps it until it disconnects, so restart the
API after migrating. The harness also
names the schemas it found, so
"is storage denied?" gets a catalogue answer. This tree has `ops` and `public`
and no `storage` schema, which is an absence, not a denial.

A new migration extends the proof by itself. The harness reads the prefixes
from `migrations/`, with no list here, in the suite or in a manifest. Add the
next `migrations/NNNN_*.sql` and it is covered.

## What a write is checked against

Two rules, both in `packages/core-records/src/commands/prepare.ts`. A rule held
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
`commands/surface.ts`). `record` is checked against the task named in
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

Seven reads are declared in `COMMAND_SURFACE` with `kind: 'read'` and served by
`packages/core-records/src/reads/`. Three of them are this file's:

- `task.read { recordId }` → the task, its state, its assignee and its history
- `task.board { board }` → the tasks on a board; `null` is the unboarded ones,
  which is where a task created without a board lives
- `person.list {}` → the people with an active membership, which is the set
  `task.assign` will accept

The other four, `task.queue`, `preset.plan`, `settings.read` and
`session.capabilities`, are listed with their answers under "Reads" in
[API.md](API.md#reads).

On the person prefix a read carries no `operation_id` and no
`expected_revision`: there is nothing to replay and nothing to be stale
against. On the agent prefix every call, reads included, carries an
`operation_id`, because the agent envelope refuses a call without one
(`runAgentCommand` in `packages/core-records/src/commands/agent-envelope.ts`).
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
`tasks/reconcile-visibility.ts`). It changes no other field row and no record.
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
grant (`scripts/local-seed.mjs`, `ensureExternalEntry` and `seedExternalUser`).
It shares a task with it only when rerun with `LOCAL_SEED_SHARE_TASK` naming a
task by key or id, through `shareRecord` under the admin's own `share` grant
(`shareWithExternal`). The tests make their own external party with
`tests/acceptance/world.ts`'s `enrolExternal`.

**Carry the existing external entry before seeding against a shared GoTrue.**
When `.local/synthetic-users.json` has no `role: 'external'` entry, the seed
writes a new one with a new password and then sets that password on the GoTrue
user (`ensureExternalEntry`, `seedExternalUser`). Against a GoTrue that other
checkouts also use, that resets the external party's password for all of them.
Copy the existing entry into the file first.

Identity comes from `.local/synthetic-users.json`, which `auth:seed`
(`scripts/local/auth-seed.mjs`) writes because the GoTrue subjects are its to
mint. Until that file exists the seed writes a placeholder with random subjects
and says on every run that those identities cannot sign in.
