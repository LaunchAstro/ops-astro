<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The local slice's data layer

The real Postgres the working slice runs on, the schema it carries, and how to
start, migrate, seed and prove it. Local only: nothing here is a deployment, and
nothing here is the Hub's `supabase_*` database or the draft's.

## Owned resources

| Thing     | Identity                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Container | `ops-astro-local-pg`                                                                                  |
| Image     | `postgres@sha256:77f5851…a1873`, the digest pinned in [supply-chain-pins.md](../supply-chain-pins.md) |
| Address   | `127.0.0.1:54390`                                                                                     |
| Volume    | `ops-astro-local-pgdata`, mounted at `/var/lib/postgresql`                                            |
| Database  | `ops_astro_local`                                                                                     |

The mount path matters. Postgres 18 keeps its cluster in a subdirectory of
`/var/lib/postgresql`; a volume mounted at `/var/lib/postgresql/data` makes the
server find a cluster in a directory it does not use and refuse to start.

## Roles, and the two URLs

`scripts/local/db-up.sh` writes both into `.local/db.env`, which is gitignored.

- `DATABASE_ADMIN_URL` — the owner. Migrations, the seed, and the test harness,
  which creates a throwaway database per run.
- `DATABASE_URL` — the runtime role `app`, a member of the group role
  `ops_astro_app` that the migrations grant to. It owns nothing, may create
  nothing, and cannot bypass row security.

Two roles rather than one is what makes runtime DDL a refusal from the server
instead of a convention, and what makes `force row level security` the barrier
rather than the last line of one.

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

`db-down.sh` never removes the volume. Taking the data is a separate, deliberate
act: `docker rm -f ops-astro-local-pg && docker volume rm ops-astro-local-pgdata`.

## What the schema is

**`migrations/` is the authority.** The directory holds every migration from
`0001_tenancy` onward, `db-migrate.mjs` applies whatever is in it in order, and
the prefix harness below reads the same directory. No number here or in any
suite says which migration is the last one, because a number written down is a
number the next migration makes wrong.

The first seven, `0001_tenancy` to `0007_command_envelope`, are the tenancy,
identity, grant, record and command-envelope spine ported from
`ops-astro-t1-draft@60f2009`. What was added after them belongs to two
companions rather than to this file: the agent-authority, settings and
delegation migrations are described in [AUTHORITY.md](AUTHORITY.md), and the
proposal, gate, decision, budget, lease and attempt migrations in
[RUNTIME.md](RUNTIME.md). Read `ls migrations/` for the current set.

There is **no `tasks` table**. A task is a record of the built-in `task` record
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

There is no `status` column and no second coarse field: "is this done" is the
machine category of the state record the task points at.

## What the tenancy proofs are

Six suites under `tests/tenancy/`, each against its own database migrated from
empty. `DATABASE_URL` unset means they print that nothing ran rather than
showing a green tick, and `scripts/db-conformance.mjs` fails a run in which a
named suite skipped.

| Suite                         | What it holds                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `statement-log.test.ts`       | The reading of SQL the no-DDL law depends on: quoting, dollar quoting, comments.                  |
| `tenancy-conformance.test.ts` | The catalogue rules and the composite-key linter, every one of them broken on purpose and caught. |
| `tenancy-wrapper.test.ts`     | The barrier between two businesses on the wrapper itself.                                         |
| `pooled-crossover.test.ts`    | A→B on one physical backend.                                                                      |
| `migration-prefixes.test.ts`  | Every rule after every migration prefix, with three separated roles.                              |
| `runtime-statements.test.ts`  | What a real task command and read actually send.                                                  |

### The pooled crossover

The wrapper suite drives a handle itself; that is not the pooled failure. The
pooled one is that A's operation finishes, the pool hands the same backend to
B, and something A left on the session is still there. Asking inside B's
transaction cannot answer it, because B's own `SET LOCAL` overwrites whatever
was left before B can read it.

So `pooled-crossover.test.ts` runs two real `task.create` commands over one
pool of size 1, records `pg_backend_pid()` at every step and asserts a single
backend, and reads the connection **between** the transactions through
`connectObserved`. That factory is the only supported door onto a pooled
connection outside the wrapper, and it exists for this proof. `connect`, which
is what the application gets, has no such door.

What the mutation showed, with the wrapper's `set_config` `is_local` argument
temporarily `false`: the setting survives A's commit, a no-setting read on the
reused backend returns A's rows, and the setting is still A's after a rollback.
What it did **not** show is B reading A's row, because B's own setup overwrites
the session-wide value first. That case passes under the leak, so it is not
what the proof rests on.

### The migration prefixes

A conformance set run against the end state answers a question nobody asked.
An installation is really in the state after `0001`, and a deploy that stops
between two migrations leaves it in one of them. So
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
role — row security does not filter `TRUNCATE`, so holding it empties every
tenant's rows without a policy being consulted — and no superuser or
`bypassrls`. The harness also names the schemas it found, so "storage is
denied" is answered with a catalogue: this tree has `ops` and `public` and no
`storage` schema, which is an absence rather than a denial.

**A new migration extends the proof by itself.** The prefixes are read from
`migrations/`; there is no list here, in the suite or in a manifest. Add the
next `migrations/NNNN_*.sql` and it is covered.

## What a write is checked against

Two rules, both in `packages/core-records/src/commands/prepare.ts`, because a
rule held in one handler is a rule the next handler forgets.

**The target is locked before its revision is compared.** A targeted write reads
its record `for update` and only then compares `expectedRevision`. Without the
lock two writes presenting the same revision each read the record as it stood
before the other's uncommitted write, both passed the comparison, and the second
silently restored what the first had replaced — while telling its caller
`applied`. With it the second waits, re-reads the committed revision and is
refused `VERSION_STALE`. Optimistic concurrency is only as good as the row the
comparison reads.

**The authority target comes from the declaration, not the body.** A command
with `targetsExistingRecord` is checked against that record; every other command
is checked against the business, whatever identifiers its body carries. Deriving
it from `request.recordId` instead let a record-scoped grant turn a refused
`task.create` into an accepted one by naming the record it did hold. An
identifier an untargeted command has no use for is now refused
`COMMAND_BODY_INVALID` naming the field, rather than ignored: a body whose
identifier the server quietly drops is a body the caller believes was honoured.

### A setting is checked against its revision

`business_settings` is not a record, so `prepare.ts` does not reach it, but the
rule is the same one. Migration `0020_business_settings_revision.sql` gives the
table `revision integer not null default 1` with a check that it is at least 1.
The default is what upgrades an installation that already had settings: every
existing row starts at 1, so no reader ever meets a null revision.

The revision moves in one place. `writeBusinessSetting`
(`packages/core-records/src/records/business-settings.ts:346`) reads the row
`for update`, compares the caller's `expectedRevision` when one is sent, and
then writes the value and `revision = revision + 1` in one statement (`:388`),
so the row never holds a new value at an old revision. A mismatch is refused
`VERSION_STALE` naming `revision=<current>`, and the value is left as it was.
Both settings commands write through it (`commands/settings-write.ts:114`), so
every command write moves the revision by exactly one, and `settings.read`
hands the current number back.

There is **no trigger**, unlike `records.revision`. The migration's header says
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

A read carries no `operation_id` and no `expected_revision`: there is nothing to
replay and nothing to be stale against. It runs through `withSession` and the
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
memberships and grants. It is idempotent by lookup: a second run finds every row
and inserts none.

**It never seeds a task.** A seeded task is a task nobody created, and it would
make every acceptance case pass without the product working.

Two identities carry negative cases:

- `noah@alpha.local` — a real member of A with **no grants**, for "an
  authenticated member without task collection scope" (N2).
- `orphan@alpha.local` — a verified login with no mapping and no membership,
  for `AUTH_NO_MEMBERSHIP` (N2's second half).

The seed enrols no external party. `tests/acceptance/world.ts`'s
`enrolExternal` makes one for the tests, and `shareRecord` gives it its share.

Identity comes from `.local/synthetic-users.json`, which SLICE-API writes
because the GoTrue subjects are its to mint. Until that file exists the seed
writes a placeholder with random subjects and says on every run that those
identities cannot sign in.
