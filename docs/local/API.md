<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The working slice's API

The HTTP boundary for the local working slice: what it exposes, how a caller
is identified, and how to start and check it.

## Starting it

Run everything from the repository root, with the pinned Node on the path. The
toolchain lives outside the repository; `TOOLCHAIN` below is wherever the run's
`ops-astro-implement-readiness-2026-09-22/toolchain` directory is on this
machine.

```sh
export PATH="$TOOLCHAIN/node-v24.21.0-darwin-arm64/bin:$PATH"
bash scripts/local/db-up.sh   # SLICE-DATA: Postgres on 127.0.0.1:54390
bash scripts/local/auth-up.sh # GoTrue on 127.0.0.1:54391, writes .local/auth.env
node scripts/db-migrate.mjs   # SLICE-DATA: migrations
node scripts/local/auth-seed.mjs   # the five synthetic logins
node scripts/local-seed.mjs        # SLICE-DATA: businesses, persons, logins, grants
bash scripts/local/api-up.sh  # the API on 127.0.0.1:8790
node scripts/local/verify-slice.mjs
```

`auth-up.sh` starts Postgres itself if it is not already up, with the same
container name, pinned digest, port and volume `db-up.sh` uses, so the two
converge whichever runs first. Neither script touches the Hub's `supabase_*`
containers.

`.local/` holds `db.env`, `auth.env`, `synthetic-users.json`,
`synthetic-agents.json` and `gate.env`. It is gitignored and never enters a
commit. The seed writes the last two. `synthetic-agents.json` holds the agent
identities each business gets and the password each signs in to GoTrue with.
`gate.env` holds the key decisions are signed with. The seed generates them once
and reads them back, because a second
seed minting a new secret would leave every decision already on the chain
signed by a key this deployment no longer holds.

## Routes

Every route is `POST /api/b/:businessKey` + the command's path, and every path
is derived from `COMMAND_SURFACE`: `task.create` is `/api/b/alpha/task/create`.
No path is written by hand. An operation another part declares is reachable
with no edit to the API, and a command with no declaration has no route.

`GET /api/health` is the one exception. It runs a statement and answers from
the result: `200` with `database: "reachable"`, or `503` with
`database: "unreachable"` and the reason. It also reports whether the read half
of the surface is mounted.

| Body               | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `operationId`      | Required on every mutation. The repeat-request identity.           |
| `expectedRevision` | Required on a command with an existing record to be stale against. |
| `fields`           | The values the command owns. Reads take neither of the two above.  |

A success is the envelope's outcome: `recordId`, `revision`, `detail`. A
refusal is `{ refused: true, code, names, fixes }` (`refuse` in
`apps/api/app.ts`) under the status the refusal register's own column gives
the code (`statusOf`, `commands/register.ts`). A client branches on the code.
A proxy and a log reader see the status. Neither is derived from the other.

**Admission is the same on both prefixes.** Every generated route goes
through `admit` (`apps/api/app.ts`), which asks in this order:

1. A missing, forged, unsigned or subject-less bearer is `AUTH_UNKNOWN_LOGIN` 401.
2. An expired bearer is `AUTH_SESSION_EXPIRED` 401, before the business key or
   the body is read.
3. A body that is not a JSON object is `COMMAND_BODY_INVALID` 400, whatever
   business the key names. Admission writes one `authentication_attempts` row
   only when the key resolved to a business. Its owner is `person_login` or
   `agent_login`, its outcome `refused` and its code `COMMAND_BODY_INVALID`,
   and it holds the subject only as a digest (`recordBodyRefusal`,
   `identity/authentication-attempts.ts`, which takes a verified subject only).
   A key that names none writes nothing and answers the same bytes. Neither
   case writes an `audit_events` row or stores the body or a credential. A
   body with no canonical form, such as a number too large for a double
   (`1e400` parses to `Infinity`), is `COMMAND_BODY_INVALID` 400 in the same
   way on every prefix: `readObject` (`apps/api/app.ts`) runs
   `canonicalPayload` (`commands/digest.ts`) over the parsed body, and a throw
   is a body refusal.
4. A key that names no business answers exactly as login resolution answers a
   caller the business does not know: `AUTH_NO_MEMBERSHIP` 403 with login
   resolution's fixes on `/api/b/…`, and `AUTH_NO_AGENT_IDENTITY` 401 on
   `/api/a/b/…`. The fixes are imported, not copied: `NO_MEMBERSHIP_FIXES`
   from `identity/login-resolution.ts` and `NO_AGENT_FIXES` from
   `identity/agent-login.ts`.
5. Anything else reaches the executor, and login resolution runs there,
   inside the serving transaction.

`tests/api/boundary-body-admission.test.ts` holds the body refusal and what it
writes. `tests/api/admission-enumeration.test.ts` compares the raw bytes for a
foreign key and a fabricated one on both prefixes, for a valid body and a
malformed one, and holds the expired bearer on every key.

**An absent or mistyped operand is refused by name, not answered as a fault.**
Five operations used to take their request type at its word and answer a
plain-text 500 when an operand was missing. Each now answers
`FIELD_VALUE_INVALID` 422, naming the operand, with a fix line
(`packages/core-records/src/commands/operands.ts`):

| Operation                                    | Operand                                  | What it has to be                                                          | Checked at                                                                                             |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `task.create`                                | `fields`                                 | an object of field keys to values, not an array                            | `refuseCreateOperands`, from `createTask` (`tasks-write.ts`)                                           |
| `task.update` and the five owning operations | `fields`                                 | an object of field keys to values, not an array                            | `refuseUpdateOperands`, from `updateTask` (`tasks-write.ts`) and `writeOwnedFields` (`tasks-state.ts`) |
| `task.reparent`                              | `parentId`                               | a string, or `null` for the top level; absent or any other type is refused | `refuseReparentOperands`, from `reparentTask` (`tasks-place.ts`)                                       |
| `task.restore`                               | `batchId`                                | a non-empty string, the one `task.trash` answered                          | `refuseRestoreOperands`, from `restoreTasks` (`tasks-trash.ts`)                                        |
| `task.purge`                                 | none                                     | no window operand, see below                                               | `refusePurgeOperands`, from `purgeTasks` (`tasks-trash.ts`)                                            |
| `task.read`                                  | `recordId`                               | a string                                                                   | the row's `parse`, from `serveRead` (`reads/dispatch.ts`)                                              |
| `task.board`                                 | `board`                                  | a board task's id, or `null` for tasks on no board                         | the row's `parse`, from `serveRead` (`reads/dispatch.ts`)                                              |
| `preset.plan`                                | `recordTypeKey`, `presetKey`, `fields[]` | two non-empty strings, and an array of field objects, which may be empty   | the row's `parse`, from `serveRead` (`reads/dispatch.ts`)                                              |

The five `refuse…Operands` functions are in `commands/operands.ts`, beside
`isFieldMap` and `invalid`, which the read catalogue shares. A read's operand
check is the `parse` column of its `READ_CATALOGUE` row (`reads/catalogue.ts`).
It answers the read's typed operands (`ReadOperands`) or the refusal, and the
row's `subject`, `authority` and `serve` see only those operands. `ReadRequest`
is the unchecked body.

**`task.purge` takes no window.** It reads the business's own
`retention_window_days` setting inside the transaction the command is served in
(`retentionWindowDays`, `commands/tasks-trash.ts`), and the cutoff is the
database's `now()` less that many days (`cutoff`, same file). A body that still
names `olderThanDays`, with any value including a valid one, is refused
`COMMAND_BODY_INVALID` 400 naming it (`refusePurgeOperands`). That is the code
any body field the operation does not take already gets
(`refuseIrrelevantTarget`, `commands/prepare.ts`). Nothing is purged and the
refusal writes an audit row. A business with no such row is `NOT_FOUND` naming
`retention_window_days`. A row that is not a whole number of days, zero or
more, is `FIELD_VALUE_INVALID`. There is no default, floor or ceiling.
`tests/commands/purge-retention.test.ts` holds it.

The answer's `detail` is `{ purged, retained }`: `purged` is a count and
`retained` lists the aged trashed tasks that runtime rows still point at (a
proposal lineage, a planned run, a task envelope or a lease). They are kept,
not purged and not faulted on, because the runtime class is refused
(`purgeTrashedRecords`, `tasks/trash.ts`). Restoring the batch, or a later
runtime retention rule, is what releases them.

The five command checks run in their handlers, each as the handler's first
check (`refuseUpdateOperands` in both `updateTask` and `writeOwnedFields`), so
the refusal is registered and audited like any other command refusal.
The read checks run inside the audited read (the row's `parse`, called from
`serveRead` in `reads/dispatch.ts`), after the system-field and identifier
checks and before the grant check, so a refused read writes its audit row like
any other.
`tests/api/operand-refusals.test.ts` holds the first five over HTTP, absent and
mistyped, and that a well-formed request still succeeds on each. `task.board`
joined them later. A body with no `board` used to be answered the unboarded
list, and is now `FIELD_VALUE_INVALID` 422 naming `board`, as is any `board`
that is neither a string nor `null` (`tests/api/boundary-read-targets.test.ts`).
`task.update` and `task.reparent` joined after final review round 1
(`tests/commands/final-r1-place.test.ts`). A `parentId` string that is not an
identifier is the envelope's `NOT_FOUND` (`refuseMalformedIdentifier`,
`commands/prepare.ts`). The five owning operations (`task.assign` and the rest)
joined next: `writeOwnedFields` (`commands/tasks-state.ts`) calls
`refuseUpdateOperands` first, so an absent, null, string or array `fields` is
refused naming `fields` and nothing is written. An empty map stays
`FIELD_UNKNOWN` (`tests/commands/final-r1-place-owned.test.ts`).
On the agent prefix, `task.read` does not go through `reads/dispatch.ts`. A
`recordId` that is present and not a string is refused before any authority,
in the person prefix's bytes. That is `FIELD_VALUE_INVALID` 422 naming
`recordId` on `task.read` (the read catalogue's own `parse`) and `NOT_FOUND` 404
on `task.comment` (`recordIdOperand` in `commands/agent-operations.ts`,
THERMO-RECHECK-2 NNA1). Under a live delegation an absent one is `NOT_FOUND` 404. The check falls back to the delegation's own task, and the row serves only
the task the check was made on (`namedTaskId` in `commands/agent-authority.ts`).

## Who is calling

`Authorization: Bearer <GoTrue access token>`. The adapter verifies the HS256
signature and `exp` with `SUPABASE_JWT_SECRET` and takes `sub` as
`VerifiedSubject { provider: 'supabase', subject }`.

Nothing else reaches identity. Not a body field, not a host or forwarded
header, not an `apikey`, not a query parameter. A request carrying `actorId` or
`businessId` alongside its token is a request with those fields nowhere to go.
A missing, forged, unsigned or subject-less token all answer
`AUTH_UNKNOWN_LOGIN`, because telling them apart tells an unauthenticated
caller which guess was closer. An expired token is the one exception and
answers `AUTH_SESSION_EXPIRED` 401. It is not a guess. Its signature verifies
against this deployment's own secret, so the caller learns nothing they could
not already prove and gains the re-login path. A bearer whose signature does not
verify is `AUTH_UNKNOWN_LOGIN` whatever its `exp` says. `hono/jwt` checks `exp`
before the signature, so the adapter verifies a bearer Hono calls expired again,
with the expiry check off, before it answers `AUTH_SESSION_EXPIRED`
(`signatureVerifies`, `apps/api/auth/supabase.ts`).

The business is named by the path and verified by login resolution. A business
the caller is not a member of and a business that does not exist both answer
`AUTH_NO_MEMBERSHIP` 403 on the person prefix, in the same bytes, for the same
reason an unmapped subject and a missing login refuse identically. The
difference is an inference across a tenancy boundary. The agent prefix does
the same with `AUTH_NO_AGENT_IDENTITY` 401 (step 4 of admission, above).

A key that more than one business holds names none of them. It answers the same
bytes as a key nobody holds, and the answer is not cached
(`createBusinessResolver`, `apps/api/server.ts`). Since migration 0027, Nathan's
approved backstop, `businesses_key_global_idx` makes a business key unique across
businesses, so storage refuses a second business under a held key with `23505`
(`migrations/0027_business_key_global.sql`;
`tests/runtime/final-r1-fr1-migrations.test.ts`). The resolver's refusal stays
as the check at request time.

`AUTH_NO_MEMBERSHIP` 403 also refuses a mapped person of the business who holds
no membership and no live share. A non-member who does hold a live share, and
no business grant, resolves as an **external party** (R4), and the session's
`roleKey` is null (`resolveLogin`, `identity/login-resolution.ts`).
`shareRecord` (`authority/shares.ts`) issues shares, under the sharer's own
`share` grant. No HTTP route issues one yet (see "Open items" below).

The verifier names the algorithm itself rather than reading it from the
token's header, so a token nominating `alg: none` verifies against no key.

## What the boundary is not

It holds no authority check. Every refusal in a response came back from the
operation, inside the serving transaction, through the grant path.

It reads no record. The only statement it causes outside `withBusiness` is the
business-key lookup (`createBusinessResolver`, `apps/api/server.ts`), which
reads one column of at most two rows. The tenancy root sits behind forced row
security keyed on a setting the serving transaction has not set yet, so that one
mapping has to come before tenancy. Every statement after it runs through the
wrapper. The one write before the executor is admission's body refusal, which
runs in the resolved business's own `withBusiness`.

It imports no executor. `createApi` (`apps/api/app.ts`) takes all three from
its caller: `executeCommand` and `executeRead` are required, and
`executeAgentCommand` is optional. `ReadExecutor` is `typeof executeRead` and
`CommandExecutor` is `typeof executeCommand`, both type-only imports, so the
real executors pass without a cast. With no `executeAgentCommand` the agent
prefix is not mounted. The one value the boundary takes from an envelope
module is `agentAnswer` (`commands/agent-envelope.ts`), which flattens the
agent's `session.capabilities` answer at the wire. It takes the handle
(`CommandHandle`), because the boundary answers a refusal first, so `app.ts`
passes it with no cast.

## The composition root

`apps/api/server.ts` exports `composeApi(config)`. It builds the served app
with `/api/health`, the boundary and the fault mapping (`server.onError`), and
returns it with the app's business resolver. It reads no environment, opens no
socket and starts no process. `main()` runs only as the process entry
(`import.meta.main`). It reads the environment, calls `composeApi`, runs
restart recovery through that same resolver, and only then binds the port.
Tests build the server with `composeApi` (`compose` in `tests/api/fixture.ts`),
so they run the wiring the server listens with rather than a copy of it. A
test that hands the boundary its own executor or recorder calls `createApi`
directly.

## Task, board and people operations

The everyday task writes, and the two reads the web's board and task page
use. Each is a row of `COMMAND_SURFACE` (`commands/surface.ts`), so its route is
the general rule above. Every write also answers the envelope's own refusals:
`OPERATION_ID_REQUIRED` 422, `OPERATION_ID_REUSED` 409, `COMMAND_BODY_INVALID`
400, `FIELD_NOT_WRITABLE` 422 for a system-owned field and `SCOPE_NOT_GRANTED`
403, and a write with a target also `EXPECTED_REVISION_REQUIRED` 422,
`NOT_FOUND` 404 and `VERSION_STALE` 409 (`runCommand` and `replayOrRefuse`,
`commands/envelope.ts`; `prepareCommand`, `commands/prepare.ts`). The table
lists what each adds.

A replay of a stored success answers the authority held now. It takes the same
preparation a fresh call takes, without the target's revision, so a revoked
grant's replay is `SCOPE_NOT_GRANTED` 403 and not the stored result. A person
pickup replay is also released only while its lease is live and the caller's
(`LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `RESERVATION_NOT_CLAIMABLE` 409).
The register row is unchanged and the audit row is `refused` (`replayOrRefuse`
and `withheldNow`, `commands/envelope.ts`). The lease check is
`pickupReceiptBinding` (`commands/pickup-receipt.ts`), the one statement the agent
pickup replay also uses (`replayPickup`, `commands/agent-replay.ts`).
`tests/runtime/person-replay-current-rights.test.ts` holds it.

An identifier field an untargeted write does not take is refused
`COMMAND_BODY_INVALID` 400 naming it, before authority. That holds on every
untargeted person-path write, including `task.heartbeat`, `task.cancel`,
`task.restart`, `grant.revoke` and `delegation.revoke`, since `4a5e615`. The
fields each write takes are its row's `untargetedIdentifiers` in
`COMMAND_SURFACE`, checked by `refuseIrrelevantTarget` (`commands/prepare.ts`).

| Operation                                                                             | Route                                  | Body                                                                    | Refusals it adds                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.update`                                                                         | `/task/update`                         | `operationId`, `recordId`, `expectedRevision`, `fields`                 | `FIELD_UNKNOWN` 422, `TRANSITION_PROTECTED` 422 (a field another operation owns, or a board change), `FIELD_VALUE_INVALID` 422 (also naming `fields` when it is not an object), `SOURCE_SPOOFED` 403, `PLACEMENT_IS_DERIVED` 422 (`board_rank`, which `task.rank` owns; `board_section` on a subtask) |
| `task.start`, `task.complete`                                                         | `/task/start`, `/task/complete`        | `operationId`, `recordId`, `expectedRevision`                           | `TRANSITION_NOT_PERMITTED` 409 when the task is already in that state                                                                                                                                                                                                                                 |
| `task.reopen`                                                                         | `/task/reopen`                         | `operationId`, `recordId`, `expectedRevision`, `reason`                 | `TRANSITION_NOT_PERMITTED` 409 unless the task is completed                                                                                                                                                                                                                                           |
| `task.assign`, `task.triage`, `task.set_stage`, `task.set_party`, `task.set_audience` | `/task/assign` and so on, one per name | `operationId`, `recordId`, `expectedRevision`, `fields`                 | `FIELD_UNKNOWN` 422 (also for an empty `fields`), `TRANSITION_PROTECTED` 422 for a field the operation does not own, `FIELD_VALUE_INVALID` 422 (also naming `fields` when it is absent, null, a string or an array), `NOT_FOUND` 404 naming a person field                                            |
| `task.reparent`                                                                       | `/task/reparent`                       | `operationId`, `recordId`, `expectedRevision`, `parentId` (or null)     | `FIELD_VALUE_INVALID` 422 naming `parentId` when it is absent or neither a string nor `null`, `PLACEMENT_IS_DERIVED` 422 (its own parent, or any of its descendants), `PARENT_TRASHED` 409, `NOT_FOUND` 404                                                                                           |
| `task.move`                                                                           | `/task/move`                           | `operationId`, `recordId`, `expectedRevision`, `board`, `boardSection?` | `PLACEMENT_IS_DERIVED` 422 (a section on a subtask), `FIELD_VALUE_INVALID` 422, `SCOPE_NOT_GRANTED` 403 when the caller may not write the destination board (asked on the board's record, before the board is looked up; a business grant covers every board), `NOT_FOUND` 404 naming `board`         |
| `task.rank`                                                                           | `/task/rank`                           | `operationId`, `recordId`, `expectedRevision`, `afterId?`, `beforeId?`  | `PLACEMENT_IS_DERIVED` 422 when neither neighbour is sent, `NOT_FOUND` 404 naming `neighbour`                                                                                                                                                                                                         |
| `task.trash`                                                                          | `/task/trash`                          | `operationId`, `recordId`, `expectedRevision`                           | `SCOPE_NOT_GRANTED` 403 when a live descendant is not covered (below); the answer's `detail` carries `batchId`, which `task.restore` takes, and `trashed`, the count                                                                                                                                  |
| `task.board`                                                                          | `/task/board`                          | `board`, required: a board id, or `null` for the unboarded tasks        | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404 for a board not live here and for an external party, `FIELD_VALUE_INVALID` 422, `FIELD_NOT_WRITABLE` 422; answers `{ ok: true, tasks }`                                                                                                                      |
| `person.list`                                                                         | `/person/list`                         | `{}`; it takes no fields                                                | `SCOPE_NOT_GRANTED` 403 without `read` on `person`, `FIELD_NOT_WRITABLE` 422; answers `{ ok: true, persons: [{ personId, name }] }`                                                                                                                                                                   |

`task.assign` takes the `assign` action, `task.set_party` and
`task.set_audience` take `share`, and every other write here takes `write`, all
on `task` (their `COMMAND_SURFACE` rows). The two reads take `read` on `task`
and on `person`. A rank is always placed between neighbours and never sent as a
number. The handlers are the cases of the same name in `commands/handlers.ts`
and `reads/dispatch.ts`; the manifest below cites each one. On the agent prefix
all of these answer `DELEGATION_EXCLUDES_OPERATION` 403.

**`task.trash` asks `write` on the task and on every live descendant the walk
reaches.** A business-scoped grant covers them all. Otherwise each descendant
needs its own record-scoped grant. If any is not covered, the answer is
`SCOPE_NOT_GRANTED` 403 with no names and no count, and nothing is trashed
(`refuseUnreached`, `commands/tasks-trash.ts`, called from `trashSubtree` in
`tasks/trash.ts` between the walk and the update).

**`intake_state` and `source` in `fields`.** On `task.update`, `intake_state`
with any value, `accepted` included, is `TRANSITION_PROTECTED` 422 naming
`intake_state=task.triage`; `source` is `SOURCE_SPOOFED` 403. On `task.create`
both are `SOURCE_SPOOFED` (`SPOOFABLE_ON_CREATE`, `SPOOFABLE_ON_UPDATE` and
`refuseSpoof`, called from `createTask` and `updateTask` in
`commands/tasks-write.ts`). Either answer writes nothing, and the attempted
value goes to the audit row only. By root ruling, the transaction contract's
T1-N3 and contract-ledger row D03 take precedence here over the older
minimum-contract 6.1 wording, which answered `SOURCE_SPOOFED` to
`intake_state: accepted` on any write.
`tests/acceptance/protected-fields.test.ts` holds both, in "D03: intake_state on
task.update names task.triage; task.create keeps SOURCE_SPOOFED".

**A top-level key naming a system field is `FIELD_NOT_WRITABLE` 422**, by name.
The list is the envelope's own (`SYSTEM_OWNED_FIELDS`) plus every installed
field whose `field_defs.write_mode` is `system`, which today adds
`completed_at`, `key`, `task`, `edited_at` and `machine_category`
(`SYSTEM_OWNED_FIELDS` and `claimedSystemFields`, `commands/prepare.ts`). It
applies on the person prefix, on the agent prefix and on every read. A nested
key is the operation's own question: `fields.completed_at` is the field engine's
refusal, and `fields.source` stays `SOURCE_SPOOFED`.
`tests/api/boundary-system-fields.test.ts` holds it.

**`task.board` names its board or asks for none.** `board: null` lists the
business's unboarded tasks. A board id must name a live task in the caller's
business. A foreign, fabricated, malformed or trashed board is `NOT_FOUND` 404,
the same body as any unknown record, audited in the caller's business with no
subject, and never answered as an empty list (the `serve` of the `task.board`
row and `boardExists`, `reads/catalogue.ts`; minimum contract 8.2 cases 1 and
3).
`tests/commands/board-not-found.test.ts` holds it. `WRONG_BUSINESS` stays
registered and unproducible (minimum contract 4.4, as corrected 14 September
2026): a cross-business probe is `NOT_FOUND` to the caller and `NOT_FOUND` in
the prober's own audit (`UNPRODUCED_CODES`, `commands/register.ts`).

## The operations L2 made possible

Four rows joined the surface when L2's model modules landed, and one came off
the pending list. Each reaches the API and the command line by generation, with
no route written by hand.

| Operation                          | Route                               | Body                                                                              | Refusals it can answer                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.comment`                     | `/task/comment`                     | `operationId`, `recordId`, `expectedRevision`, `body`, `audience`, `commentType?` | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404, `VERSION_STALE` 409, `DEPENDENCY_NOT_LANDED` 501 where a business has no comment type                                                     |
| `preset.plan`                      | `/preset/plan`                      | `recordTypeKey`, `presetKey`, `fields[]`                                          | `FIELD_VALUE_INVALID` 422 for an absent or mistyped operand, `SCOPE_NOT_GRANTED` 403, `PRESET_FIELD_UNCLASSIFIED` 422, `PRESET_TYPE_UNKNOWN` 404, `PRESET_FIELD_UNPLACEABLE` 409, `PRESET_FIELD_DUPLICATE` 422 |
| `settings.set_four_eyes_threshold` | `/settings/set_four_eyes_threshold` | `operationId`, `value` (number or `null`), `expectedRevision?`                    | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                                                       |
| `settings.set_client_sign_off`     | `/settings/set_client_sign_off`     | `operationId`, `value` (boolean), `expectedRevision?`                             | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                                                       |

A settings `value` of any other type, including a string, an object or an
array, is `FIELD_VALUE_INVALID` naming `value` before any write
(`setBusinessSetting`, `commands/settings-write.ts`), so nothing a jsonb column
cannot hold reaches `business_settings`.

`task.comment` writes a comment record beside the task and leaves the task's
own revision alone, so a caller may keep writing against the revision they
hold. The author is the acting actor and the posting time is the server's;
neither is a payload field.

`preset.plan` is declared `kind: 'read'` because it writes nothing, even on
success. It is the one read that does not take the `read` action, which is why
the collection and the action are on the declaration rather than assumed from
the kind.

**The grant `preset/plan` needs is `manage` on the family the request names,
not on `preset`.** A body with `recordTypeKey: "task"` takes `manage` on
`task`; planning a preset into another family takes `manage` on that family.
A caller holding a blanket `manage` on `preset` and nothing else is refused
`SCOPE_NOT_GRANTED` 403, naming the family they are missing. The planner
bounds itself to the owned family, and the route asks the same question in
front of it rather than a wider one, so the two cannot disagree about who may
plan what.

A preset that names one new field key twice is refused `PRESET_FIELD_DUPLICATE`
422 naming the repeated keys, before any action is planned. Two entries
claiming one key cannot both be created, and a plan promising something the
apply cannot do would be worse than a refusal. Nothing is written, as with
every other refusal here and with every success.

The two settings commands take an optional `expectedRevision`, which migration
`0020_business_settings_revision.sql` made possible. `business_settings` now
carries a revision, and `settings.read` projects it on every setting. A write
naming a revision the row has moved past is refused `VERSION_STALE` 409 with
`names = ['revision=<current>']`, and the stored value is unchanged. It is
optional because a caller who has not read the setting may still set it.
Omitting it is a last-writer-wins write, and naming it is the optimistic check.
The applied result carries the `revision` the row is now at, which is the one
the next write names. How the writer locks and moves
the revision, and which tests hold it, is in
[AUTHORITY.md, "Business settings"](AUTHORITY.md#business-settings); the column
itself is in [DATA.md](DATA.md#a-setting-is-checked-against-its-revision).

**`OPERATION_ID_REQUIRED` 422 covers the omitted field too.** `null` and `''`
were always refused; an absent `operationId` was not, because
`RegExp.prototype.test` coerces `undefined` to the string `"undefined"` and the
pattern accepted it. The real `undefined` then reached the driver and the
caller was answered a plain-text 500. The envelope now checks the type before
the pattern, so every way of not sending an operation identity gets the one
answer this table promises.

On the agent prefix the boundary passes `operationId` exactly as the JSON
carried it. The agent envelope asks `typeof` itself (`runAgentCommand`,
`commands/agent-envelope.ts`), so a number, an array, `null` or an absent field
is `OPERATION_ID_REQUIRED` 422 and registers nothing. The refusal still writes
its refused audit row. `tests/api/agent-operation-id.test.ts` holds the HTTP
half, including that the envelope receives the raw value, and
`tests/commands/agent-operation-id.test.ts` the envelope half.

## The operations L4's runtime made possible

`NOT_LANDED` is empty. Nothing in `COMMAND_SURFACE` answers
`DEPENDENCY_NOT_LANDED` because a part it rests on has not been built.

| Operation       | Route            | Body                                                                                                                                       | Refusals it can answer                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task.propose`  | `/task/propose`  | `operationId`, `recordId`, `expectedRevision`, `purpose`, `maximumMinor`, `currency`, `payload`, `step`, `expiresInSeconds?`, `lineageId?` | `SCOPE_NOT_GRANTED` 403, `PROPOSAL_OUT_OF_SCOPE` 403, `GATE_NOT_FOUND` 404, `LINEAGE_TERMINAL` 409, `LINEAGE_NOT_ON_TASK` 409, `CHANGE_ROUNDS_EXHAUSTED` 409, `VERSION_STALE` 409, `NOT_FOUND` 404, `FIELD_VALUE_INVALID` 422                                                                                                                                      |
| `task.decide`   | `/task/decide`   | `operationId`, `gateId`, `versionId`, `decision`, `note`                                                                                   | `NOT_FOUND` 404, `GATE_ALREADY_DECIDED` 409, `GATE_EXPIRED` 410, `VERSION_SUPERSEDED` 409, `EVIDENCE_MISMATCH` 409, `LINEAGE_TERMINAL` 409, `BUDGET_UNAVAILABLE` 409, `BUDGET_EXHAUSTED` 402, `CAP_BINDING_MISMATCH` 409, `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422 naming `note` when the note is not a string or carries a NUL or an unpaired surrogate |
| `task.pickup`   | `/task/pickup`   | `operationId`, `reservationId`, `leaseSeconds?`                                                                                            | `RESERVATION_NOT_CLAIMABLE` 409, `LEASE_HELD` 409, `SCOPE_NOT_GRANTED` 403 (person), `DELEGATION_ALREADY_LIVE` 409 (agent), `DELEGATION_WIDENS` 403, `DEPENDENCY_NOT_LANDED` 501 (agent, no delegation key), `FIELD_VALUE_INVALID` 422, `COMMAND_BODY_INVALID` 400 (person)                                                                                        |
| `task.handback` | `/task/handback` | `operationId`, `leaseId`, `fence`, `outcome`, `report?`, `actualMinor?`, `successor?`                                                      | `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `SUCCESSOR_OUT_OF_BOUNDS` 409, `ACTUAL_EXPENDITURE_UNSUPPORTED` 422, `FIELD_VALUE_INVALID` 422                                                                                                                                                                                                                         |
| `task.queue`    | `/task/queue`    | nothing; it is a read                                                                                                                      | `SCOPE_NOT_GRANTED` 403                                                                                                                                                                                                                                                                                                                                            |

**A trashed task's work is not handed out.** `task.queue` leaves it out, and
`task.pickup` of its reservation answers exactly as an unknown reservation
does: `RESERVATION_NOT_CLAIMABLE` 409 with the same two fixed sentences, and no
lease is written (`queue` and `pickup`, `core-runtime/src/pickup.ts`).
Restoring the task brings the work back.
`tests/runtime/final-r1-fr1-runtime-cont.test.ts` holds it.

`task.propose` answers `FIELD_VALUE_INVALID` 422 for the two shapes its columns
constrain, before the write rather than at it: a `purpose` outside
`^[a-z][a-z0-9_]{0,62}$` names `purpose`, and a `step` that is not
`{ kind, payload }` with a non-empty `kind` and an object `payload` names
`step`. Both used to reach the database and arrive as `SERVICE_UNAVAILABLE`
503, which tells a caller their server is broken when their request was.

`task.propose` writes a proposal beside the task and leaves the task's own
revision alone, so a caller may keep writing against the revision they hold.
The proposer, the subjects and the expiry instant are the server's. A body
naming an absolute `expiresAt` could raise a gate nobody can decide or hold a
ceiling open for a decade, and a duration the server adds to its own clock can
do neither. `expiresInSeconds` is a whole number from 1 to 604800, a maximum of
seven days (owner decision, 23 Sep 2026). Leaving it out takes seven days.
604801, zero or a fraction is `FIELD_VALUE_INVALID` 422 naming
`expiresInSeconds` and the maximum, and it writes nothing but its refused
audit row (`tests/api/expiry-bound.test.ts`). Existing gates are not
rewritten.

`task.propose` with a `lineageId` that is not in the caller's business answers
`GATE_NOT_FOUND` 404 with a constant reason, so a foreign id and a fabricated
id get identical bytes (`proposeUnderLocks`, `core-runtime/src/propose.ts`).

`task.decide` names the exact version it is deciding. It is compared under
the locks and never trusted, so a decision made from a page that has gone stale
is `VERSION_SUPERSEDED` rather than a decision about something the decider never
read. The refusal names the gate and the version it carries, never the version
presented, so a foreign and a fabricated `versionId` on the caller's own gate
answer the same bytes. The signing key and the budget cap are not in the body.
The key comes from the deployment's environment and the cap is the business's
own, read rather than created, because a command that created the ceiling it
then spent against could never be refused `BUDGET_EXHAUSTED`.

A gate not visible in the caller's business, foreign or fabricated, answers
`NOT_FOUND` 404 with a constant body that carries no id, and the refusal is
audited in the caller's business (`GATE_NOT_VISIBLE` in `decideOnGate`,
`commands/tasks-decide.ts`). `GATE_NOT_FOUND` is no longer a `task.decide`
answer, because the handler translates the runtime's code before answering.

Three of those codes arrived with lane L4-RUNTIME-FIX and are registered here
with the statuses the runtime suggests. `LINEAGE_NOT_ON_TASK` 409 is
`task.propose` naming a `lineageId` that belongs to a different task in the
same business. The caller may hold it legitimately, and it is still not this
task's. `CAP_BINDING_MISMATCH` 409 is a decision whose version is in a currency
the task's open envelope was not opened in; the cap half of that check is not
reachable through a command, because every decision on a business reads the
same cap. `ACTUAL_EXPENDITURE_UNSUPPORTED` 422 is below.

`task.handback` takes `actualMinor` only so that sending one is an answer
rather than a silence. Nothing in this head dispatches, so no number here can
be honest, and any non-null value is `ACTUAL_EXPENDITURE_UNSUPPORTED` 422
naming the key; `null` and leaving it out are the same request. Its result
carries `reportId`, the identity of the durable handback report, because a
report nobody can name is a report nobody can read.

`task.handback` takes an optional `successor`, which is how a worker that
has finished one piece of work proposes the next without a person having to open
the task again. Its caller-supplied half is `{ purpose, maximumMinor, currency,
payload, step: { kind, payload }, expiresInSeconds? }`. `expiresInSeconds` is
the same duration `task.propose` takes, read through the same `expiryFrom`, with
a maximum of seven days (owner decision, 23 Sep 2026). Leaving it out takes
seven days. Over the maximum is `FIELD_VALUE_INVALID` 422 naming
`successor.expiresInSeconds`, and it settles nothing. An absolute
`successor.expiresAt` is refused by name. `proposedByActorId` is not a body
field. It is the agent actor of the session. A caller who sends it, under either
spelling, is refused `FIELD_NOT_WRITABLE` naming `successor.proposedByActorId`,
on both entries, with the fix "The successor is recorded as proposed by the
actor of your session, …" (`successor.ts`).
The attempted value goes to the audit row and never to the response, as with
every other system-owned field. The result carries four handles,
`successorVersionId`, `successorGateId`, `successorRunId` and `successorStepId`,
all four null together when no successor was asked for.

The settlement and the successor commit together or not at all. A handback
that opens a successor is one transaction, so a reader that sees the report sees
the pending gate, and a fault in either takes both with it.
`SUCCESSOR_OUT_OF_BOUNDS` 409 is the exception that settles nothing. The
lease is still live and the hold still held, so the caller may retry with a
successor that fits, or hand back without one. That is the opposite of the two
stale-fence refusals below, which do write their retained report. The runtime
side of the successor and the tests that hold it are in
[RUNTIME.md, "The successor is part of the settlement"](RUNTIME.md#the-successor-is-part-of-the-settlement).

**A handback refusal can commit.** `LEASE_NOT_OWNED` and `LEASE_EXPIRED`
on `task.handback` are answered _after_ the runtime has written an append-only
`handback_reports` row with `disposition = 'retained'`. A stale holder's work
was still done, and the refusal and the retained report are one fact.
Every other refusal rolls its handler's savepoint back; these two release it,
and the handler says which it is rather than a list of codes held somewhere
else. `ACTUAL_EXPENDITURE_UNSUPPORTED` is deliberately not one of them. It is
refused before the first write, so there is nothing to keep.

On the agent prefix a handback refused `DELEGATION_NOT_LIVE` or
`DELEGATION_NARROWED` also keeps one `retained` row naming that code. The
credential must name a delegation of this business and this agent, and the
lease and fence must be exactly that delegation's. For `DELEGATION_NOT_LIVE`
the delegation is this agent's own ended one. A narrowed agent's report is kept
in two cases. Its delegation was revoked for `authority_lost` (R-B), or its
delegation is still live and the delegating person's write grant covering the
handback's task has since expired or otherwise lapsed. In the second case the
credential must still resolve live for this business and agent, and the
authority check on the presented lease's own task must answer
`DELEGATION_NARROWED` (`retainLateHandback` and `narrowedOnLease`,
`commands/agent-late-handback.ts`; `resolveNarrowedDelegation`,
`authority/delegations.ts`). Nothing is revoked and the delegation stays live.
In every case the answer is unchanged and nothing else is written
([RUNTIME.md, "Why the lease is fenced"](RUNTIME.md#why-the-lease-is-fenced)).
`tests/runtime/historical-handback-intake.test.ts` holds the paths.

This intake never keeps a handback that claims spend. The agent entry refuses
a non-null `actualMinor` among its operands (`parseOperands`,
`commands/agent-operations.ts`), before authority is read, so the call answers
`ACTUAL_EXPENDITURE_UNSUPPORTED` 422 and never reaches `retainLateHandback`.
The three `actualMinor 1` cases in the same test file, one for each path
above, prove it: 422, no retained row, one refused audit row. Each then sends
`actualMinor: null` and gets the path's own refusal with the report retained.

**An expired lease is recovered by a new pickup.** A `task.pickup` of a
reservation whose lease has expired succeeds into a fresh hold with a new
`reservationId` and `attemptId`, and the projection shows the abandoned hold
beside the fresh one. The pickup settles the agent's expired delegation for
that purpose in the same transaction before it mints the new one
(`mintDelegation`, `authority/delegations.ts`), so the old credential answers
`DELEGATION_NOT_LIVE`. `tests/api/task-runtime-routes.test.ts` holds it as a
plain positive case, in "recovers an expired lease into a fresh hold with new
identifiers".

**A person picks up, renews and hands back as themselves.** On the person prefix
`task.pickup`, `task.heartbeat` and `task.handback` are served on a lease that
carries no delegation. The holder is the session's own actor, the authority is
the session's own live grants, re-read under the claim's locks, and no
credential is minted (the `task.pickup`, `task.heartbeat` and `task.handback`
cases of `handleCommand`, `commands/handlers.ts`, which call `pickupAsPerson` in
`commands/tasks-pickup.ts`, `heartbeatOwnLease` in `commands/tasks-lease.ts` and
`handbackOwnLease` in `commands/tasks-handback.ts`). The agent does the same on
its own entry point, below, with the delegation its pickup minted. Neither
reaches the other's lease. A person's `reservationId` that is not a string is
`COMMAND_BODY_INVALID` 400, and a person's handback of a lease that is not
theirs is `LEASE_NOT_OWNED` 403. `tests/runtime/person-work-http.test.ts` holds
the person path.

**The pickup answer** carries, for both principals, `claimant` (`person` or
`agent`), `leaseId`, `fence`, `reservationId`, `attemptId`, `taskId`, `runId`,
`versionId`, `expiresAt`, `declaredIncompleteness`, `holderActorId`,
`authorisedByPersonId`, `brief { taskId, purpose }`,
`expectedVersions { versionId, taskRevision }`,
`budgetEnvelope { envelopeId, currency, heldMinor }`, `permittedOperations`
and `excludedOperations`, each exclusion with its reason, and `handbackShape`.
Only the agent's answer adds `delegationId`, `credential` and `purposeScope`; a
person's carries none of them and no placeholder
(`pickupDetail`, `commands/tasks-pickup.ts`).

**`handbackShape`** (TRANSACTION-CONTRACT line 64, root ruling 6) says how to
hand this lease back and grants nothing. Its operands are keyed by the owning
`task.handback` contract, `HandbackFields` (`HANDBACK_OPERANDS`,
`commands/pickup-handback-shape.ts`), so an operand added, dropped or made
optional there does not compile until the descriptor follows. `required` is
`leaseId`, `fence` and `outcome`, and `optional` is `report`, `actualMinor`
(null only) and `successor`. `operationIdentity` is the envelope's `operationId`
and its replay rule; `lease` repeats this pickup's `leaseId` and `fence`;
`outcomes` is `completed` or `failed`. `credential` names where the claimant's
credential travels, never the credential itself. That is the
`x-agent-delegation` header for an agent and the person's own bearer for a
person. `versionBinding` has no operand. The lease is bound to `versionId`, and the handback refuses `LEASE_NOT_OWNED`, keeping the
report, when that version was superseded or its lineage is no longer live
(`handback`, `core-runtime/src/handback.ts`). `task.handback` takes no
`expectedVersions` and no record revision; `expectedVersions.taskRevision` is
the task as read at pickup. `tests/commands/agent-pickup-payload.test.ts`
asserts the answer field by field against the rows it names, for both
principals. `authorisedByPersonId` is read from the approving decision, never
from the body.

**`RESERVATION_NOT_CLAIMABLE` 409 is one answer** for a reservation that does
not exist, one with no approval behind it and one another live lease holds.
The holding lease is never named (`claim`, `commands/tasks-pickup.ts`;
`NOT_CLAIMABLE_REASON` in `pickup`, `core-runtime/src/pickup.ts`).

**A malformed reservation or lease id answers as a fabricated one, on both
prefixes.** A `reservationId` or `leaseId` that is not a uuid, `""` and
`"not-a-uuid"` included, names nothing. `task.pickup` answers
`RESERVATION_NOT_CLAIMABLE` 409, and `task.heartbeat` and `task.handback` answer
`LEASE_NOT_OWNED` 403, in the same bytes as a well-formed id that names nothing
(root ruling 2). The refusal is audited in the caller's business and nothing is
written. The check is one shape test, `isIdentifier` (`commands/operands.ts`,
which delegates to `isUuid` in `tenancy/ids.ts`, as `isBusinessId` does),
called where both claimants meet: `claim` in `commands/tasks-pickup.ts`,
`renewLease` in `commands/tasks-lease.ts` and `settle` in
`commands/tasks-handback.ts`. The agent envelope's lease lookup checks the same
shape with the same `isUuid` (in `namedTaskId`, `commands/agent-authority.ts`).
A malformed id never reaches a uuid parameter, so it is never `SERVICE_UNAVAILABLE` 503, which TC:11 keeps
for real faults. Both prefixes refuse a `reservationId` that is not a string,
`COMMAND_BODY_INVALID` 400 (below). `tests/api/id-operand-shape.test.ts` holds
it.

**On the agent prefix each operand is read by its JSON type before any
authority.** A `reservationId` that is not a string is `COMMAND_BODY_INVALID`
400, an `outcome` that is not a string or a `fence` that is not a number is
`FIELD_VALUE_INVALID` 422, and nothing is claimed, settled or retained
(`pickupOperands` and `handbackOperands`, `commands/agent-operations.ts`).
`tests/runtime/agent-operand-types.test.ts` holds it.

**A payload naming a fact the server owns is refused** `FIELD_NOT_WRITABLE`
422, naming the keys, with nothing written (D06). `business_id`, `actor_id`,
`person_id`, `created_at`, `updated_at`, `revision`, `source`, `author` and
their camel-case spellings are all derived by the server, and the check is in
`prepareCommand`, which every command goes through. The attempted values go to
the audit event and never to the response.

A text field value holding a NUL or an unpaired surrogate, and a json field
value holding either in any string or key, is refused `FIELD_VALUE_INVALID`
422 naming the field as `key=type`: every field value lands in `records.data`,
which is jsonb and cannot hold them (`fits` and `refuseWrongValueType`,
`commands/values.ts`).

A NUL or an unpaired surrogate in an attempted key or value is stored as its
JSON escape text (`\u0000`), because a jsonb string cannot hold it
(`storable`, `commands/audit.ts`, called by `writeAuditEvent`). The payload
digest covers the value as received. On both prefixes, a refusal name that
echoes a caller key holding such a code unit is registered as its JSON escape
text (`storable`, called by `registerAttempt` in `commands/register-store.ts`).
Both prefixes answer it in that form the first time and on replay, so the bytes
match (`settle` in `commands/envelope.ts` and in `commands/agent-settle.ts`).

## The support controls

The contract ledger requires revocation, cancellation with an authorised
restart, and the lease heartbeat through owning production interfaces, as
declared operations. These five rows are on `COMMAND_SURFACE`, so the person
prefix, the agent prefix and the command line route them with no hand list, and
`tests/acceptance/surface-inventory.test.ts` enumerates them with every other
row. Routed is not the same as served. Revocation, cancellation and restart are
served on the person prefix and the command line, and the agent prefix refuses
them `DELEGATION_EXCLUDES_OPERATION`. The heartbeat is served on both prefixes,
each for its own kind of lease: an agent's under the delegation its pickup
minted, and a person's own delegation-free lease under their current grants.
None is a new actor power. Each asks for authority the caller already holds.

| Operation           | Route                | Body                                                        | Authority                                                                                                                                                           | Refusals it can answer                                                                                                                                                |
| ------------------- | -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grant.revoke`      | `/grant/revoke`      | `operationId`, `grantId`                                    | `manage` on tasks, asked at the revoked grant's own scope, then the manager's own ceiling: `manage` and the grant's own pair on its collection, at a covering scope | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` 409 (already revoked), `COMMAND_BODY_INVALID` 400                                                |
| `delegation.revoke` | `/delegation/revoke` | `operationId`, `delegationId`                               | as `grant.revoke`, asked at the delegation's purpose scope, over every (collection, action) the delegation reaches                                                  | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `DELEGATION_NOT_LIVE` 401 (already revoked, settled or expired), `COMMAND_BODY_INVALID` 400                                 |
| `task.cancel`       | `/task/cancel`       | `operationId`, `recordId`, `lineageId`, `reason`            | `write` on the task named in `recordId`, the work-control authority `task.propose` asks; a record-scoped grant is enough                                            | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `LINEAGE_NOT_ON_TASK` 409, `LINEAGE_TERMINAL` 409, `FIELD_VALUE_INVALID` 422, `COMMAND_BODY_INVALID` 400                    |
| `task.restart`      | `/task/restart`      | `operationId`, `recordId`, `lineageId`, `expiresInSeconds?` | `write` on the task named in `recordId`, plus `propose`'s own read and write checks                                                                                 | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `LINEAGE_NOT_ON_TASK` 409, `TRANSITION_NOT_PERMITTED` 409 (live, completed or already restarted), `FIELD_VALUE_INVALID` 422 |
| `task.heartbeat`    | `/task/heartbeat`    | `operationId`, `leaseId`, `fence`, `leaseSeconds?`          | the lease's holder: an agent presenting the delegation minted with it, or a person on their own delegation-free lease under current `write`                         | `DELEGATION_NOT_LIVE` 401 (agent), `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `FIELD_VALUE_INVALID` 422                                                              |

What each one does:

- **Revocation** writes `revoked_at` on the row, and the envelope's applied
  audit row names the revoked row's id as its subject. In the same transaction
  it releases the leases of work that lost its authority, an agent's or a
  person's own, and classifies their holds (`classifyAuthorityLoss`, called from
  `revokeGrantAsManager` and `revokeDelegationAsManager` in
  `commands/authority-controls.ts`; the runtime side is in
  [RUNTIME.md](RUNTIME.md)). Both answer with `detail.classifiedHolds`, the ids
  of the reservations the revocation classified, and nothing about whose they
  were (`classifiedHolds`, `authority-controls.ts`). The envelope asks `manage`
  at the revoked row's own scope (`SCOPE_OF.target` and `TARGET_LOOKUPS`,
  `commands/prepare.ts`), so `SCOPE_NOT_GRANTED` is also the answer for a
  manager whose `manage` does not cover that scope, as well as for one outside
  the ceiling (`withinCeiling` and
  `OUTSIDE_CEILING`, `authority-controls.ts`). Nothing is cached, so the next
  call on the same session re-evaluates and is refused. A read admitted before
  the revocation finishes in its own transaction. This is I10's endpoint half,
  in `tests/api/controls-revoke.test.ts` and the role-case matrix's case (f).
- **Cancellation** reaches `cancelAndClassify`. The lineage becomes
  `cancelled` with the reason as its terminal reason, the live lease is
  released, and the lineage's holds are classified. The answer is
  `{ lineageId, state: 'cancelled', reservations: [{ reservationId, state, released }] }`.
  A pickup afterwards is `RESERVATION_NOT_CLAIMABLE` 409, and the refusal is
  audited. A new version in the lineage is `LINEAGE_TERMINAL`. Cancellation
  reaches a lineage on a trashed task, so a trashed task's approved hold can
  still be released. `task.restart` on a trashed task stays `NOT_FOUND`
  (`lineageOnTask`, `commands/tasks-controls.ts`).
- **Restart** takes no proposal of its own. It proposes the terminal lineage's
  last version again under a new lineage whose `restarts_lineage_id` names the
  old one. The answer is `{ lineageId, restartsLineageId, versionId, version: 1, gateId, payloadDigest }`.
  The new gate is pending, with no decision and no hold, and the old lineage,
  lease and hold are never reopened or reused (G05). A terminal lineage is
  restarted once. `expiresInSeconds` has the same bound as `task.propose`:
  maximum seven days (owner decision, 23 Sep 2026).
- **Heartbeat** moves the lease's expiry, and on an agent's lease its
  delegation's, to now plus `leaseSeconds` (1 to 3600, default 900). It is
  capped at 8 hours after the pickup (`MAXIMUM_LEASE_LIFETIME_SECONDS`,
  `core-runtime/src/heartbeat.ts`, a lane constant) and never shortens a lease:
  past the cap a beat is applied and leaves `expires_at` where it was. A stale
  fence or someone else's lease is `LEASE_NOT_OWNED`. A settled, revoked or
  expired delegation is `DELEGATION_NOT_LIVE`, and a lease past its instant is
  not revived. No timer runs. Bounded unstarted recovery stays with the owning
  operations' classifier ([RUNTIME.md](RUNTIME.md)). Both bounds are open items
  below.

## Source-to-route manifest

Every route is generated from `COMMAND_SURFACE`
(`packages/core-records/src/commands/surface.ts`, 28 writes and 7 reads) by
`mountSurface` in `createApi` (`apps/api/app.ts`), once for the person prefix
and once for the agent prefix, with the path from `pathOf` in the same file.
The command line builds its verbs from the same table (`VERBS`,
`apps/cli/client.ts`) and posts them to the person prefix, or to the agent
prefix when a call asks for it. Both mounts are `PREFIX` in
`commands/surface.ts` (`/api/b/` and `/api/a/b/`), and the delegation header's
name is `DELEGATION_HEADER` there, which `apps/api/app.ts` imports.
`GET /api/health` (its route in `composeApi`, `apps/api/server.ts`) is the one
route outside the table. Every name is routed on both prefixes. The tables say
where each is served and where it is refused.

No test keeps a second list of names.
`tests/acceptance/surface-inventory.test.ts` enumerates the surface from
`COMMAND_SURFACE` itself over four surfaces: the person prefix, the agent
prefix, the command line (`apps/cli/client.ts`) and the web client
(`apps/web/src/operations/client.ts`). A row added to the table is a new case
there, and a row one surface cannot reach fails it.

Every row below is a `COMMAND_SURFACE` declaration. Cites are symbols, not line
numbers. A person-prefix write is the entry of that name in `HANDLERS`, which
`handleCommand` calls (`commands/handlers.ts`), and a person-prefix read is the
`serve` of the row of that name in `READ_CATALOGUE` (`reads/catalogue.ts`),
which `serveRead` runs (`reads/dispatch.ts`). The tables name the function each
case calls.

The five support controls, with their owning functions:

| Operation           | Person route                            | Agent route                             | Handler                                                                                                                                                                               | Owning function                                                                                             |
| ------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `grant.revoke`      | `/api/b/:key/grant/revoke`              | refused `DELEGATION_EXCLUDES_OPERATION` | `revokeGrantAsManager` (`commands/authority-controls.ts`)                                                                                                                             | `revokeGrant` (`authority/grants.ts`)                                                                       |
| `delegation.revoke` | `/api/b/:key/delegation/revoke`         | refused `DELEGATION_EXCLUDES_OPERATION` | `revokeDelegationAsManager` (`commands/authority-controls.ts`)                                                                                                                        | `revokeDelegation` (`authority/delegations.ts`)                                                             |
| `task.cancel`       | `/api/b/:key/task/cancel`               | refused `DELEGATION_EXCLUDES_OPERATION` | `cancelOnTask` (`commands/tasks-controls.ts`)                                                                                                                                         | `cancelAndClassify` (`core-runtime/src/recovery.ts`)                                                        |
| `task.restart`      | `/api/b/:key/task/restart`              | refused `DELEGATION_EXCLUDES_OPERATION` | `restartOnTask` (`commands/tasks-controls.ts`)                                                                                                                                        | `restart` (`core-runtime/src/restart.ts`) → `propose`, with `refuseRestart` (`core-runtime/src/propose.ts`) |
| `task.heartbeat`    | `/api/b/:key/task/heartbeat`, own lease | `/api/a/b/:key/task/heartbeat`          | person: `heartbeatOwnLease` (`commands/tasks-lease.ts`); agent: the row's `serve` (`AGENT_OPERATIONS`, `commands/agent-operations.ts`) → `heartbeatLease` (`commands/tasks-lease.ts`) | `heartbeat` (`core-runtime/src/heartbeat.ts`)                                                               |

The other thirty. `runAgentCommand` (`commands/agent-envelope.ts`) refuses a
name outside `AGENT_SURFACE` before it reads anything else. Each name the agent
is served is a row of `AGENT_OPERATIONS` (`commands/agent-operations.ts`), and
its `serve` holds the case. `AGENT_SURFACE` and `BEFORE_PICKUP` are read off
the surface rows' own `agent` field (`COMMAND_SURFACE`), so the surface table
says what an agent reaches and `AGENT_OPERATIONS` says how each is served.
`tests/commands/agent-surface-derivation.test.ts` holds the two to one list.

| Operation                          | Person prefix: owning function                                                            | Agent prefix                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `task.create`                      | `createTask` (`commands/tasks-write.ts`)                                                  | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.update`                      | `updateTask` (`commands/tasks-write.ts`)                                                  | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.complete`                    | `setState` (`commands/tasks-state.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.reopen`                      | `setState` (`commands/tasks-state.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.comment`                     | `commentOnTask` (`commands/tasks-comment.ts`)                                             | served under a live delegation, `internal` audience only (the row's `serve`, `AGENT_AUDIENCES`) |
| `task.propose`                     | `proposeOnTask` (`commands/tasks-propose.ts`)                                             | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.decide`                      | `decideOnGate` (`commands/tasks-decide.ts`)                                               | refused `DELEGATION_EXCLUDES_DECISION` (`authorise`, `decideAsAgent`)                           |
| `task.pickup`                      | `pickupAsPerson` (`commands/tasks-pickup.ts`)                                             | served before a pickup (`BEFORE_PICKUP`, `serve`)                                               |
| `task.handback`                    | `handbackOwnLease` (`commands/tasks-handback.ts`)                                         | served under a live delegation (`serve`)                                                        |
| `task.start`                       | `setState` (`commands/tasks-state.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.assign`                      | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.triage`                      | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.set_stage`                   | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.set_party`                   | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.set_audience`                | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.reparent`                    | `reparentTask` (`commands/tasks-place.ts`)                                                | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.move`                        | `moveTask` (`commands/tasks-place.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.rank`                        | `rankTask` (`commands/tasks-place.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.trash`                       | `trashTask` (`commands/tasks-trash.ts`)                                                   | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.restore`                     | `restoreTasks` (`commands/tasks-trash.ts`)                                                | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.purge`                       | `purgeTasks`, window read by `retentionWindowDays` (`commands/tasks-trash.ts`)            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.read`                        | `readTaskDetail`, or `readSharedTask` for a reader who is not internal (`reads/tasks.ts`) | served under a live delegation (`serve`)                                                        |
| `task.board`                       | `readBoard` (`reads/tasks.ts`)                                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `task.queue`                       | `readQueue` (`reads/queue.ts`)                                                            | served before a pickup (`BEFORE_PICKUP`, `serve`)                                               |
| `person.list`                      | `listPeople` (`reads/people.ts`)                                                          | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `preset.plan`                      | `planPresetSync` (`records/preset-plan.ts`)                                               | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `settings.read`                    | `readSettings` (`reads/settings.ts`)                                                      | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `session.capabilities`             | `readCapabilities` (`reads/capabilities.ts`)                                              | served under a live delegation (`authorise`, `capabilitiesOf`)                                  |
| `settings.set_four_eyes_threshold` | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |
| `settings.set_client_sign_off`     | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                         |

"Served under a live delegation" means an agent call with no credential is
refused `DELEGATION_EXCLUDES_OPERATION` (see "The agent's own entry point").

## Proposal projection

`task.read` carries every proposal on the task under `proposals`, newest
lineage first. It is on the detail rather than behind a read of its own because
a page that showed the evidence and then fetched the version separately could
offer a decision on a version it never displayed, and the exact version is the
whole of what `decide` compares.

A `task.read` answer's gate states, decisions and reservations come from one
database snapshot. `readTaskProposals` (`reads/proposals.ts`) takes the
versions, gates and reservations in the same statement that reads the decision
chain (`readVerifiedProjection`, `reads/verified-decisions.ts`), so one answer
never shows a gate `pending` beside its own verified decision.
`tests/reads/projection-snapshot.test.ts` and
`tests/surfaces/proposal-snapshot.test.tsx` hold the relation and the controls
the web draws from it.

```ts
proposals: {
  lineageId: string;
  state: string;                       // live, rejected, cancelled
  versions: {                          // newest first; the head is the live one
    versionId: string;                 // what task.decide takes
    version: number;
    purpose: string;
    maximumMinor: number;
    currency: string;
    payloadDigest: string;
    payload: unknown;
    supersededAt: string | null;
    runId: string | null;
    evidence: { id; renderer; digest; body } | null;
    gate: { id; state; round; expiresAt; expired; payloadDigest } | null;
  }[];
  decisions: {                         // the chain as stored, oldest first
    id; seq; decision; round; decidedByPersonId; decidedAt;
    signingKeyId; signature; prevHash; hash;
    linkVersion: 1 | 2 | 3;            // the signed payload format
    signedFields: string[];            // the item fields the signature covers
  }[];
  reservations: {
    id; state; heldMinor; actualMinor; classifiedCause; leaseId;
    lease: { id; fence; state; expiresAt; holderActorId } | null;
    attempt: { id; state; dispatchMarker; observed } | null;
  }[];
}[]
```

Three things about the shape matter. First, `gate.expired` is the
server's answer, so a client with a skewed clock cannot disagree with the
gate about whether it may still be decided. The owner decision of 23 September
2026 governs it: show expired on read and preserve the stored record
([RUNTIME.md](RUNTIME.md#why-a-lapsed-gate-reads-expired-but-stays-pending)).

- A gate stored `pending` whose `expiresAt` is at or before the database's
  `now()` reads `state: 'expired'`, `expired: true`. The row itself stays
  `pending`, and `task.decide` on it still answers `GATE_EXPIRED` 410.
- The boundary is inclusive, the same `expires_at <= now()` as that refusal.
- A decided gate (approved, rejected, changes-requested or superseded) reads
  its stored `state` and `expired: false` whatever the clock says.

Second, the decision links are the stored rows, hash and all, and `task.read`
verifies every decision it returns before it answers
(`reads/verified-decisions.ts`). It walks the business's decision chain from
genesis to the newest returned decision, recomputes each payload digest from the
stored JSON, and checks the signature and link hash with the deployment key,
resolved by each row's `signing_key_id` (today the resolver's one entry is the
configured `GATE_SIGNING_KEY_ID`; `configuredKeys`, `reads/proposals.ts`). It
then compares each shown or linked column with the row's signed payload. A read
also fails when the gates and lineages record a decision the chain lacks: a
decided gate with no decision, a gate-rejected lineage with no rejection, or a
round its requested changes do not account for. The values handed back are the
stored ones, never recomputed ones, and stored rows are never altered, because a
tampered row is the evidence. Third, the evidence pack is the renderer's output
as stored, never re-rendered on read. Evidence that changed between the
decision and the display is the one thing a gate cannot survive.

**A read whose decisions do not verify is a fault, not a refusal.** It answers
`DECISION_INTEGRITY` 500 with fixed words, no stored value and no `refused`
flag: `{ code, names: [], fixes }` (`ReadIntegrityFault`, `reads/dispatch.ts`).
An unknown key id or no key configured fails the same way. Retrying gives the
same answer. No audit row survives the failed read, because the transaction
rolls back with it, and the server log carries where the chain broke. The real
server lets the fault answer as itself through `server.onError` in
`composeApi` (`apps/api/server.ts`). `tests/api/server-onerror.test.ts` proves
it answers 500, not 503 `SERVICE_UNAVAILABLE`, twice: in process through
`composeApi`, and over the socket with `server.ts` started as its own process
when `SURFACE_API_PORT` names a spare port.

**Each decision item says what its signature covers.** The signed format is
`link` inside the signed payload, not a column, so changing it breaks the
signature; absent is v1 (`linkVersionOf`, `core-runtime/src/signing.ts`).

- v1, before 23 September 2026, signs the gate, version, decision, person,
  note and evidence digest. v2 adds `link: 2`. Both list `decision`,
  `decidedByPersonId` and `signingKeyId` in `signedFields`.
- v3, from 23 September 2026, also signs the decision id, seq, previous link
  hash, lineage, round, acting actor, `decided_at` and signing key id, and lists
  `id`, `seq`, `decision`, `round`, `decidedByPersonId`, `decidedAt`,
  `signingKeyId` and `prevHash` (`SIGNED_FIELDS`, `reads/proposals.ts`).
- Gate, version, decision, person and evidence are compared on every format,
  and on v3 every signed field is too. Any difference is `DECISION_INTEGRITY`.
- The shown `decidedAt` is millisecond ISO. The signed value is the
  microsecond UTC text, `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
- v1 and v2 rows are verified for what they signed, never rewritten, and shown
  with their `linkVersion`. Their round, time, lineage, acting actor, id,
  sequence and previous link are covered only by the unkeyed chain link.

`tests/reads/decision-integrity-read.test.ts` and
`tests/reads/decision-v3.test.ts` hold the read.

The proposals go to every reader of the detail: an internal reader on the
person prefix and the agent on its own task. The person prefix's `sharedTask`
answer for every other reader carries none (`reads/requests.ts`,
`SharedTaskView`). The projection carries no comment body and no field value
the catalogue classifies. It carries the proposal's own payload, which is what
the proposer put in it and what the decision was about, so a reader who may
see the task may see what somebody proposed doing to it.

## The agent's own entry point

`POST /api/a/b/:businessKey` + the same generated paths. It is a second entry
point onto the same surface. `/api/a/b/alpha/task/pickup` is the agent asking and
`/api/b/alpha/task/pickup` is a person asking, and neither can be mistaken for
the other by a proxy, a log reader or the server.

The command line ([CLI.md](CLI.md)) calls these same routes:
`/api/b/:businessKey` by default, and `/api/a/b/:businessKey` with `--agent`,
sending the delegation credential in `x-agent-delegation`.

`Authorization: Bearer <GoTrue access token>` says which agent login is
calling, and it resolves through `identity/agent-login.ts` rather than the
person path. A login is in `person_logins` or in `actor_logins`, never both, so
a person presenting themselves here is `AUTH_NO_AGENT_IDENTITY` 401 and an
agent presenting itself on the person path is `AUTH_NO_MEMBERSHIP` 403.

`X-Agent-Delegation: <credential>` carries the delegation `task.pickup`
returned. It is a header and not a body field for the same reason the bearer
token is. A credential in a body is a credential that gets logged with the
payload, stored in the register row and compared by a digest.

An agent login confers nothing on its own. With no `X-Agent-Delegation` header
it may read `task.queue` and call `task.pickup` (`BEFORE_PICKUP`,
`commands/agent-envelope.ts`, read off the surface rows whose `agent` is
`before-pickup`) and nothing else. `task.decide` answers
`DELEGATION_EXCLUDES_DECISION` 403, and every other operation,
`session.capabilities` included, answers `DELEGATION_EXCLUDES_OPERATION` 403
(`authorise`; minimum contract 8.2 case 9). A credential that is presented and
answers to no live delegation is `DELEGATION_NOT_LIVE` 401. It is deliberately
one answer for unknown, expired, revoked and settled. Telling them apart tells a
caller holding a stolen credential which of those it is
(`resolveDelegation`, `authority/delegations.ts`). The one exception is a
delegation revoked because its person lost the authority it draws on, which
answers `DELEGATION_NARROWED` (R-B). A name outside `AGENT_SURFACE` is refused
`DELEGATION_EXCLUDES_OPERATION` before any of this, credential or not
(`runAgentCommand`). After a pickup every call is intersected with the
delegation on the spot: the collection, the action, and a `scope` that must be
exactly the one task it was minted for.

| Answer                          | Status | When                                                                                                                                                                                                                                                     |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_NO_AGENT_IDENTITY`        | 401    | the login is not an agent login in this business                                                                                                                                                                                                         |
| `AUTH_SESSION_EXPIRED`          | 401    | the bearer's signature verifies and its `exp` has passed                                                                                                                                                                                                 |
| `DELEGATION_NOT_LIVE`           | 401    | a presented credential that answers to no live delegation                                                                                                                                                                                                |
| `DELEGATION_OUT_OF_PURPOSE`     | 403    | a sibling task, a collection or an action the purpose does not carry                                                                                                                                                                                     |
| `DELEGATION_NARROWED`           | 403    | the purpose reaches the call and the person's live grants no longer cover it, or the delegation was revoked for `authority_lost`                                                                                                                         |
| `DELEGATION_EXCLUDES_DECISION`  | 403    | `task.decide`, always: at the envelope with no credential, and from L4's `decideAsAgent` asking L2 under a delegation                                                                                                                                    |
| `DELEGATION_EXCLUDES_OPERATION` | 403    | any name not in `AGENT_SURFACE`, whose eight members are the queue, a pickup, a handback, a heartbeat, `task.read`, `task.comment`, `task.decide` and `session.capabilities`; or, with no credential, any name but the queue, a pickup and `task.decide` |
| `DELEGATION_ALREADY_LIVE`       | 409    | a pickup under a purpose word the agent already holds a live delegation for                                                                                                                                                                              |

A handback or heartbeat names a lease, not a task, so the task it is checked
against is read from the lease (`namedTaskId`). A handback naming a lease on
another task is `DELEGATION_OUT_OF_PURPOSE`. `LEASE_NOT_OWNED` is the answer
for a stale fence on the agent's own task. A lease call names its task through
its lease only: a stray `recordId` beside the `leaseId` plays no part in the
one-task check, and a `leaseId` that is not a uuid is checked on the
delegation's own task, so it answers as a fabricated one does. The one-task
ceiling (`checkDelegatedAuthority`, `authority/delegations.ts`) compares uuids
whatever their letter case, because `namedTaskId` lower-cases a uuid
`recordId` before the check.

**The request's shape is checked before authority** (`parseOperands`, called
from `runAgentCommand` before `authorise`). A system-owned field
(`SYSTEM_OWNED_FIELDS` in `commands/prepare.ts`) is refused
`FIELD_NOT_WRITABLE` 422 naming the keys, and the attempted values go to the
audit row only (D06). `leaseSeconds` on a pickup or heartbeat, when present,
must be a positive whole number, and `report` on a handback, when present, must
be an object. Any other present value, `null` included, is
`FIELD_VALUE_INVALID` 422. Leave either out to take the default. A non-null
`actualMinor` on a handback is `ACTUAL_EXPENDITURE_UNSUPPORTED` 422 here too,
before authority, which is what keeps it out of the restricted report intake.

An agent and a person refused for the same operand or the same missing task are
told the same words: the person entry's. For `leaseSeconds` that is "Name a
whole number of seconds from 1 to <route maximum>, or leave it out."
(`tasks-lease.ts`), and for `NOT_FOUND` the two identifier lines
(`refuseNotFound`). The agent entry still refuses a malformed operand before it
reads the delegation.

**A repeated agent `operationId` is released only under current rights** (the
register branch of `runAgentCommand`). A stored refusal replays as stored. A
stored success is checked again first. A read, comment or heartbeat replay
answers today's refusal (for example `DELEGATION_NARROWED` or
`DELEGATION_NOT_LIVE`), with no stored detail, once the grant, delegation or
expiry has changed. Those rows of `AGENT_OPERATIONS` replay as `reauthorise`,
and `releaseReplay` (`commands/agent-replay.ts`) runs `authorise` again. A
capabilities replay is projected again for the credential presented now
(`replayCapabilities`). A pickup replay is checked against the delegation it
minted (`replayPickup`). A handback settles its own delegation, so its receipt
is returned only to the credential that settled it (`replaySettledHandback`).
All three are in `commands/agent-replay.ts`. The register row is left as it
was. A request the register already holds is answered by `answerReplay` in the
same file, which releases a stored success through `releaseReplay`. An agent
call that does not apply ends in `settle` (register row and audit row) or
`writeCallEvent` (audit row only), both in `commands/agent-settle.ts`.

**A replayed pickup derives its credential again.** The register keeps the
pickup's answer with a null credential (`storable`). A replay of a lost pickup
response, sent with the same operation id and body and no credential, returns
the same handles and the same credential only while the delegation is live, the
delegating person's grants still cover the purpose, and the receipt's lease,
reservation, attempt and approved version are still bound, live and current.
Otherwise it answers the current refusal and no receipt content. A delegation
minted before migration 0022 (`legacy-random`) replays its handles with
`credential: null` and `credentialNote: "CREDENTIAL_NOT_REPLAYED"`
(`CREDENTIAL_NOT_REPLAYED`, `replayPickup`).
`tests/commands/pickup-replay-lost-response.test.ts` holds the derived replay,
and `tests/commands/pickup-replay-keys.test.ts` the legacy row and the key
cases. The key, and what happens when it is missing, are in
[RUNTIME.md, "The delegation credential key"](RUNTIME.md#the-delegation-credential-key).

**The agent entry retries once.** `executeAgentCommand` runs a call again, once,
in a fresh transaction when the shared `isRetryableViolation` predicate
(`commands/register-store.ts`) admits the failure: a lost identity claim, a lost
unique-value claim, a deadlock victim (`40P01`) or `AffectedSetChanged`. That
is the same predicate and the same bound as the person entry (`executeCommand`,
`commands/envelope.ts`). One
agent command reaches a thrower of `AffectedSetChanged`: `task.handback`, whose
lease-binding recheck under the locks (`core-runtime/src/handback.ts`) throws it
when the binding differs from what discovery read. The other throwers are
`grant.revoke`, `delegation.revoke`, `task.propose`, `task.cancel` and startup
replay, none of which an agent is served. `tests/runtime/retry-gaps.test.ts`
holds the handback case with a limit: no statement on this head changes the
binding's columns, so the test simulates a changed binding by rewriting that
read's result. It proves the thrown type and the one retry, two attempts with
nothing written, and not a race that can happen. A second loss reaches the
caller as a fault. The person entry then writes one `failed` audit event in a
transaction of its own, which is not a command attempt. The agent entry writes
none. The retry adds no agent cancellation authority and no startup command
retry.

Which of these a caller can meet on this head, where each is raised and which
tests hold it are in [AUTHORITY.md, "Refusal codes, as L3 registered
them"](AUTHORITY.md#refusal-codes-as-l3-registered-them). The runtime's own
codes are in [RUNTIME.md](RUNTIME.md#refusal-codes-as-l3-registered-them).

`AUTH_SESSION_EXPIRED` is answered on both paths. The rule above still
holds for everything else: a missing, forged, unsigned or subject-less token
answers `AUTH_UNKNOWN_LOGIN`, because each is a guess. An expired token is not
a guess. Its signature verifies against this deployment's own secret, so whoever
sent it held a credential this server issued a session for. They learn nothing
from being told it has run out that they could not already prove, and they gain
the re-login path.

An agent is never an internal reader. It is a delegate working one task, not a
member of the business, so `task.read` gives it `externalCommentProjection`'s
answer and an internal note is absent from it rather than hidden in it (I09).
Its `history` leaves out `task.comment` entries too, so no comment, internal or
client, shows an author or time there (`historyOf`, `reads/tasks.ts`).
An agent's `task.comment` is `internal` only: `client` is
`AUDIENCE_NOT_PERMITTED` 422 on the agent prefix, and the agent credential on
the person prefix is `AUTH_NO_MEMBERSHIP` 403
(`tests/acceptance/comment-rulings.test.ts`).

A comment on a trashed task is `NOT_FOUND` 404 on the person and agent
prefixes, in the same body as an identifier nothing carries, and nothing is
written (`writeTaskComment`, `commands/tasks-comment.ts`; comment-rulings). The
person prefix answers it before comparing `expectedRevision`
(`prepareCommand`, `commands/prepare.ts`), so a pre-trash revision gets the
same bytes as a missing task.

## Reads

`task.read`, `task.board`, `task.queue`, `person.list`, `preset.plan`,
`settings.read` and `session.capabilities` are declared in `COMMAND_SURFACE`
with `kind: 'read'`. The boundary branches on that and calls the executor the
composition root supplies:

```ts
executeRead(database, businessId, presented, request) => Promise<unknown>
```

exported as `executeRead` from `packages/core-records/src/reads/execute.ts`,
returning either the contract's `{ ok: true, ... }` shape or a command refusal.
`executeRead` is a required option of `createApi`, so every declared read has
an executor.

`task.read` carries the task's comments. An internal reader, meaning a
membership role of `owner`, `admin` or `member`, is given every comment in full.
Every other role is given `externalCommentProjection`'s answer, which is the
client comments in the fields the catalogue marks `shared` (`id`, `audience`,
`author`, `body`, `comment_type`, `posted_at`). External is the default, so a
role nobody classified sees the client view rather than everything.

A reader who is not internal on the person prefix gets a different key:
`{ ok: true, sharedTask: { id, fields, comments } }`, never `task` (the
`serve` of the `task.read` row in `READ_CATALOGUE`, `reads/catalogue.ts`).
`fields` holds the task fields the catalogue marks `shared`. A shared task
shows its client `title` and `state` (Nathan's I09 ruling, OWNER-CARD section
6), both classified `shared` on the task spine (`tasks/spine.ts`). `state` is
shown as the state's label, never its identifier (`readSharedTask`,
`reads/tasks.ts`). Every other field stays `internal` unless the catalogue
classifies it. The classification lives in `field_defs`, which the seed writes
through `installTaskSpine` (`tasks/install.ts`), not a migration. A reseed
brings an earlier install forward: on an existing task type the installer sets
`title` and `state` to `shared` where they differ (`reconcileVisibility`,
`tasks/reconcile-visibility.ts`), so an upgraded business shows both as a fresh
one does.

For an external party, a `task.read` of a record its shares do not cover and
any `task.board` answer `NOT_FOUND` 404 (the row's
`outsiderNotFound` in `READ_CATALOGUE`, `reads/catalogue.ts`, checked in
`serveRead` when the grant check refuses, `reads/dispatch.ts`;
minimum contract 8.2 case 7). Once `grant.revoke` removes an external party's
last live share, their next read is refused earlier, at login resolution:
`AUTH_NO_MEMBERSHIP` 403, since they now hold neither a membership nor a share
(`resolveLogin`, `identity/login-resolution.ts`). Neither answer carries task
content. The agent path is unchanged: an agent reads its own task through
`externalCommentProjection` under `task`.
`tests/acceptance/external-party.test.ts` drives all of it over HTTP, and matrix
case (g) carries the rows. The web types the two answers as
`TaskReadResult = InternalTaskRead | SharedTaskRead`
(`apps/web/src/operations/shapes.ts`), told apart by the key.

| Read                   | Route                   | Body                     | Answer                                                                                       | Refusals it can answer                                                                                  |
| ---------------------- | ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `settings.read`        | `/settings/read`        | `{}`; it takes no fields | `{ ok: true, settings: [{ key, value, valueType, revision, updatedAt, updatedByActorId }] }` | `SCOPE_NOT_GRANTED` 403, `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 403                             |
| `session.capabilities` | `/session/capabilities` | `{}`; it takes no fields | `{ ok: true, personId, businessKey, grants: [{ collection, action }] }`                      | `SCOPE_NOT_GRANTED` 403, `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 403, `AUTH_SESSION_EXPIRED` 401 |

`settings.read` takes `read` on `settings` while the two settings commands take
`manage` on the same collection. The asymmetry is deliberate. A setting is a
business fact every member works against, and changing one is an authority
change. The four-eyes band is stored and shown, and no first-slice operation
applies it yet. `settings.set_four_eyes_threshold` writes it
(`commands/settings-write.ts`), `settings.read` returns it, and no operation
produces `FOUR_EYES_REQUIRED`. Its consumers, top-up (S2-04) and write-off
(S2-10), are deferred (ROOT-FBFREEZE-RULINGS §3). The seed gives
`settings:read` to `admin` and to `member`; the write stays with `admin`.

**`settings.read` carries a `revision` on every setting.** It is the number
migration 0020 gave `business_settings`, and it is the number the two settings
commands take back as `expectedRevision`, so a screen that read a value can
write it back against the version it saw. Alongside it the row still carries
`updatedAt` and `updatedByActorId`, which say when the value last changed and
which actor changed it. One statement reads the value and its author
(`BusinessSetting` carries `updatedByActorId`), so both come from one commit.
Both are null on a value nobody has written since it shipped. A `revision` in a
read a caller then writes against is the whole of the optimistic check. There
is no other watermark.

`session.capabilities` is the one read with no collection of its own to hold
a grant on. It reports what the caller already holds, so it asks no single
grant; instead it is answered only to a caller who holds at least one. A member
holding no live grant is refused `SCOPE_NOT_GRANTED` 403, like every other
operation, and never answered with an empty list (the `session.capabilities`
row of `READ_CATALOGUE` and `NO_GRANT_AT_ALL`, `reads/catalogue.ts`; minimum
contract 8.2 case 3). A login that resolves to neither a membership nor an
external party's live share is `AUTH_NO_MEMBERSHIP` before any read runs. An
external party is shown its shares' pairs. The grants are read live in the
caller's own transaction through the same `effectiveGrants` the authority check
uses, so a grant revoked a moment ago is already missing from the answer. It
never carries a secret, and it never carries another person's grants. The
subjects are the session's own and there is no parameter to point at somebody
else.

On the agent prefix the same name answers only under a live delegation.
Before a pickup it is refused `DELEGATION_EXCLUDES_OPERATION` 403, and a
presented credential that is not live is `DELEGATION_NOT_LIVE` 401 (`authorise`,
`commands/agent-authority.ts`). Under a live delegation it answers only while the
delegation and the delegating person's current grants intersect on the purpose
record (`read`); otherwise it is `DELEGATION_NARROWED`. It answers the agent's
own capabilities and not the delegating person's: `agentActorId`, `businessKey`,
the delegation's `purposeScope`, `{ kind: 'record', id }`, and `grants`, which
is the current intersection of the delegation's purpose and the delegating
person's effective grants on the purpose record (root ruling 5,
`capabilitiesOf`). With every grant held that is `task` `read`, `comment` and
`write`. A pair the person lost is absent. The exception is a `grant.revoke`
that leaves the person without `write` on the task: it revokes the delegation
itself for `authority_lost`, and the answer is then `DELEGATION_NARROWED`.

**One shape on both prefixes.** Both answers are flattened beside `ok`, and
neither carries a `detail`. The subject fields differ because the subjects do,
and `businessKey` and `grants` sit at the same level on both:

| Prefix                     | Body on success                                                 | Code                                                                                                         |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| person, `/api/b/:key/...`  | `{ ok: true, personId, businessKey, grants }`                   | the `session.capabilities` row of `READ_CATALOGUE`, `reads/catalogue.ts`                                     |
| agent, `/api/a/b/:key/...` | `{ ok: true, agentActorId, businessKey, purposeScope, grants }` | `capabilitiesOf` (`commands/agent-operations.ts`), flattened by `agentAnswer` (`commands/agent-envelope.ts`) |

The agent handler still stores the answer as the handle every agent command is
stored as, `{ recordId: null, revision: null, detail }`, so a replay reads the
same register row. `agentAnswer` flattens it at the wire, called from the agent
route in `apps/api/app.ts`, for the first answer and a replay alike. Every other
agent answer keeps its payload under `detail`.

The agent answer's `grants` is read on every call and on every replay: a
replay is authorised as a fresh call and projected again for the credential
presented now, so a replay under another delegation answers that delegation's
scope and never the first one's (`replayCapabilities`).
`tests/commands/agent-capabilities-intersection.test.ts` holds both over HTTP.
`tests/api/capabilities-shape.test.ts` asserts the one shape on both prefixes
and on a replay ("answers flattened beside ok on both, and on a replay").
`tests/acceptance/role-case-matrix.test.ts` asserts the person answer flattened
with no `detail` and the no-grant refusal in case (e) ("(e) refuses every
caller who holds nothing, and never answers empty"). It asserts the pre-pickup
refusal in case (h) and the agent answer flattened with the picked-up task as
`purposeScope` after a pickup in case (i), both in "(h), (i), (j) and (g): the
agent journey, generated over the whole table".

**A read payload naming a fact the server owns is refused** `FIELD_NOT_WRITABLE`
422, naming the offending keys. It is the commands' own rule, applied by
`serveRead` (`reads/dispatch.ts`) through `prepare.ts`'s `claimedSystemFields`
rather than a second copy, so `actor_id`, `business_id`, `revision`,
`updated_at`, the installed system fields and the rest are refused on a read
exactly as they are on a write (D06). This used to be a silent drop with a `200`
on top, which is the weaker answer the accepted ledger rules out. A client that
believed it had set `actor_id` got a success and no correction, so the mistake
lived in the client and the server looked fine. The attempted values go to
the audit row's `attempted` column and never to the response.

**A read takes only its own identifier.** `task.read` takes `recordId` and
`task.board` takes `board`; `task.queue`, `person.list`, `preset.plan`,
`settings.read` and `session.capabilities` take none. Any other identifier
field, a `recordId` on those five included, is `COMMAND_BODY_INVALID` 400 naming
it, audited, and the same answer for an own, a foreign and a fabricated id
(the row's `identifiers` in `READ_CATALOGUE`, `reads/catalogue.ts`, checked in
`serveRead` after the system fields, `reads/dispatch.ts`).
`tests/api/boundary-read-targets.test.ts` holds it. The agent prefix answers the
same for `task.queue`, `task.read` and `session.capabilities`, from the same
list (`READ_CATALOGUE`), before the delegation is read (`parseOperands`,
`commands/agent-operations.ts`). `tests/api/agent-read-targets.test.ts` holds
it.

**Every read writes an audit event**, of the same shape the commands write,
successful and refused alike (I13). Its `operation_id` is null: a read has
nothing to replay. A read of one task carries that task as the subject, which
is what makes "who looked at this" answerable. The task's own `history`
excludes the reads, because a history is what happened _to_ the task.
`settings.read` and `session.capabilities` carry a null subject: neither is
about one record, and naming one would make "who read this record" false.

## Open items

Named so they are not read as settled:

- **No exported share operation.** `shareRecord` issues an external party's
  share, but no route calls it; the seed and the tests do. See "Who is
  calling".
- **The heartbeat's 8-hour lifetime cap has no HTTP case.** It is enforced in
  SQL (`core-runtime/src/heartbeat.ts`).
  `tests/runtime/schedules-heartbeat.test.ts` reaches it through the agent
  entry point by moving the lease's `acquired_at` back on the database clock.
- **The decision read's limits.** On v1 and v2 rows the fields outside
  `signedFields` are covered only by the unkeyed link, so a writer with owner
  access who recomputes every later link can change them undetected. Removing
  the newest decisions in a business still leaves a shorter chain that
  verifies; only the gate and lineage checks stand against it. The key
  resolver holds one key: rows under an earlier key id fail the read.
- **Two lane choices await root or owner confirmation.** An agent comments in
  the `internal` audience only: the `task.comment` row passes `AGENT_AUDIENCES`
  (`commands/agent-operations.ts`) to `writeTaskComment`
  (`commands/tasks-comment.ts`), which refuses `client` as
  `AUDIENCE_NOT_PERMITTED`.
  The heartbeat bounds are 1 hour a beat and 8 hours in total
  (`MAXIMUM_RENEWAL_SECONDS` and `MAXIMUM_LEASE_LIFETIME_SECONDS`,
  `core-runtime/src/heartbeat.ts`). Root ruling 6 at dd30aa8 covers bare agent
  calls and replay only, and confirms neither.

## Verifying it

`node scripts/local/verify-slice.mjs` signs in through the local GoTrue with
the seeded passwords and walks create, start, complete, reopen and edit, then
the refusals: a foreign business writing a real and a fabricated id with their
bodies and timings compared, a login with no membership, a replayed operation
identity, a reused one, a stale revision, generic writes to protected fields, a
spoofed system field, and a body and headers carrying an actor and a business
that reach nothing. One line per case with the status and the code it observed;
a case that cannot run yet prints `unrun` with its reason.
