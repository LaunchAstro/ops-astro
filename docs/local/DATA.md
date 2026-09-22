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

```sh
export PATH=…/toolchain/node-v24.21.0-darwin-arm64/bin:$PATH

bash scripts/local/db-up.sh      # start it; idempotent; writes .local/db.env
node scripts/db-migrate.mjs      # apply migrations 0001..0007, in order, once each
node scripts/local-seed.mjs      # businesses, people, logins, memberships, grants
bash scripts/local/db-down.sh    # stop the container; the volume is untouched

set -a; . ./.local/db.env; set +a
pnpm exec vitest run             # the whole suite, against this server
```

`db-down.sh` never removes the volume. Taking the data is a separate, deliberate
act: `docker rm -f ops-astro-local-pg && docker volume rm ops-astro-local-pgdata`.

## What the schema is

Migrations `0001_tenancy` to `0007_command_envelope`, ported from
`ops-astro-t1-draft@60f2009`. `0008` to `0014` — runtime, leases, gates, budget
— belong to later units and are not here.

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

## The reads

Three, declared in `COMMAND_SURFACE` with `kind: 'read'` and served by
`packages/core-records/src/reads/`:

- `task.read { recordId }` → the task, its state, its assignee and its history
- `task.board { board }` → the tasks on a board; `null` is the unboarded ones,
  which is where a task created without a board lives
- `person.list {}` → the people with an active membership, which is the set
  `task.assign` will accept

A read carries no `operation_id` and no `expected_revision`: there is nothing to
replay and nothing to be stale against. It runs through `withSession` and the
same `checkAuthority` the commands use, in the same transaction, so a revoked
grant bites on the next read. A denied read is `SCOPE_NOT_GRANTED` and never an
empty list.

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

Identity comes from `.local/synthetic-users.json`, which SLICE-API writes
because the GoTrue subjects are its to mint. Until that file exists the seed
writes a placeholder with random subjects and says on every run that those
identities cannot sign in.
