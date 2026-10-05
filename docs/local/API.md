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
node scripts/local-seed.mjs        # SLICE-DATA grants (new database: LOCAL_SEED_MADE_UP=confirm)
bash scripts/local/api-up.sh  # the API on 127.0.0.1:8790
node scripts/local/verify-slice.mjs
```

`auth-up.sh` starts Postgres itself if it is not already up, with the same
container name, pinned digest, port and volume `db-up.sh` uses, so the two
converge whichever runs first. Like `db-up.sh`, it replaces a container on
another image or volume (one made before the local database moved to
Postgres 17) and keeps every volume. Whenever it starts Postgres afresh, it
starts GoTrue afresh too, so GoTrue migrates schema `auth` on the new cluster.
Neither script touches the Hub's `supabase_*` containers.

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
the code (`statusOf`, `core-records/src/register.ts`). A client branches on the code.
A proxy and a log reader see the status. Neither is derived from the other.

**Admission is the same on both prefixes.** Every generated route goes
through `admit` (`apps/api/app.ts`), which asks in this order:

1. A missing, forged, unsigned or subject-less bearer is `AUTH_UNKNOWN_LOGIN` 401.
2. An expired bearer is `AUTH_SESSION_EXPIRED` 401, before the business key or
   the body is read. So is a session past its 12-hour absolute limit (C58,
   "Sessions" below).
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
   `canonicalPayload` (`core-digest/src/digest.ts`) over the parsed body, and a throw
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
(`packages/core-commands/src/commands/operands.ts`):

| Operation                                    | Operand                                               | What it has to be                                                                                                                                                                                | Checked at                                                                                         |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `task.create`                                | `fields`                                              | an object of field keys to values, not an array                                                                                                                                                  | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.update` and the five owning operations | `fields`                                              | an object of field keys to values, not an array                                                                                                                                                  | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.reparent`                              | `parentId`                                            | a string, or `null` for the top level; absent or any other type is refused                                                                                                                       | `refuseReparentOperands`, from `reparentTask` (`tasks-place.ts`)                                   |
| `task.restore`                               | `batchId`                                             | a non-empty string, the one `task.trash` answered                                                                                                                                                | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.purge`                                 | none                                                  | no window operand, see below                                                                                                                                                                     | `refusePurgeOperands`, from `purgeTasks` (`tasks-trash.ts`)                                        |
| `task.read`                                  | `recordId`                                            | a string                                                                                                                                                                                         | the row's `parse`, from `serveRead` (`reads/dispatch.ts`)                                          |
| `task.board`                                 | `board`                                               | a board task's id, or `null` for tasks on no board                                                                                                                                               | the row's `parse`, from `serveRead` (`reads/dispatch.ts`)                                          |
| `task.ledger`                                | `timeZone`, `before?`, `query?`                       | a zone name the server knows (`pg_timezone_names`, exact spelling), a day `YYYY-MM-DD` from 1970 or absent/`null` for the newest days, and `task.search`'s query or absent/`null` for every task | the row's `parse` for the shapes, its `serve` for the zone, from `serveRead` (`reads/dispatch.ts`) |
| `preset.plan`                                | `recordTypeKey`, `presetKey`, `fields[]`              | two non-empty strings, and an array of field objects, which may be empty                                                                                                                         | the row's `parse`, from `serveRead` (`reads/dispatch.ts`)                                          |
| `task.rank`                                  | `afterId`, `beforeId`                                 | each a string or `null`, or absent                                                                                                                                                               | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.propose`                               | `lineageId`                                           | a string or `null`, or absent to open a new lineage                                                                                                                                              | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.create`                                | `parentId`, `board`, `boardSection`, `conversationId` | each a string or `null`, or absent                                                                                                                                                               | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.decide`                                | `gateId`, `versionId`, `recipientPersonId`            | each a string; absent is refused, except `recipientPersonId`, which may be absent or `null`                                                                                                      | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |
| `task.accept_plan`                           | `gateId`, `versionId`, `conversationId`               | each a string; absent is refused, except `conversationId`, which may be absent or `null`                                                                                                         | `parseRequest`, from `prepareCommand` (`commands/prepare.ts`)                                      |

`parseRequest` and the two `refuse…Operands` functions are in
`commands/operands.ts`, beside `isFieldMap` and `invalid`, which the read
catalogue shares. A read's operand
check is the `parse` column of its `READ_CATALOGUE` row (`reads/catalogue.ts`).
It answers the read's typed operands (`ReadOperands`) or the refusal, and the
row's `subject`, `authority` and `serve` see only those operands. `ReadRequest`
is the unchecked body.

The `parseRequest` rows are their operations' `WRITE_OPERANDS`
(`core-wire/src/write-operands.ts`), checked once the caller is authorised, an
identifier before the target is read and any other operand after it. So a `lineageId`
on `task.propose` that is neither a string nor `null` is `FIELD_VALUE_INVALID`
naming `lineageId`, and the `COMMAND_BODY_INVALID` branch in `proposeOnTask`
(`commands/tasks-propose.ts`) is not reached through a command.

**A free operand the stores cannot hold is refused by name.** A comment
`body`, a cancel `reason`, a decision `note`, a proposal's `purpose`,
`currency`, `payload` and `step`, a handback's `report` and `successor`, a
privacy incident's `whatHappened`, `foundBy` and `affected`, a legal
document version's `body`, an overseas service's `service`, `receives`,
`where`, `trainsOnIt` and `contract`, a data class's `dataClass`,
`purpose`, `disclosures`, `retention` and `deletion`, a client's `name`, a client's written request's `requestedBy` and `requestLink` (C60), and a map revision's `destination`, `notes`, `addFog` and `addOutOfScope`, holding U+0000 or an unpaired surrogate, in any string or key, are
`FIELD_VALUE_INVALID` 422 naming the operand. A successor is named by its inner
key (`successor.<key>`). The check runs after authority and before the target
is read, and nothing is written (`FREE_OPERANDS` and
`refuseUnstorableOperands`, `commands/prepare.ts`; the rule is `storableJson`
in `commands/values.ts`). The agent prefix does not pass that door: the
comment body is checked in `writeTaskComment` (`commands/tasks-comment.ts`),
and a handback's `report` and `successor` among its operands, before authority
(`handbackOperands`, `commands/agent-operations.ts`).

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
The purge clears the scope (`scope_kind` and `scope_record_id` to null) of any
conversation opened on a task or comment it removes, before the delete; the
conversation, its body and its wrap-ups are kept (0092's scope reference does
not cascade).

**The two windows are written by a command each** (MP-2-11, 0068):
`settings.set_retention_window` and `settings.set_conversation_window`, under
`settings:manage`, against the revision `settings.read` handed back. The
conversation window is seven days or more and never longer than the retention
window (C122-1); either command locks both rows in key order before it
compares, and a value outside that is `FIELD_VALUE_INVALID` naming `value`.
`tests/commands/mp-2-11-business-windows.test.ts` holds it.

A window longer than 2,000,000 days (`LONGEST_COMPUTED_WINDOW_DAYS`) purges
nothing, and it is answered, not refused. No trash is that old, and a long
enough window would take the date arithmetic past the database's calendar
(`cutoff`, `commands/tasks-trash.ts`).

The answer's `detail` is `{ purged, purgedIds, retained, commentsPurged, grantsRevoked }`.
`purged` is a count and `purgedIds` names the purged tasks. `retained` lists
the aged trashed tasks that runtime rows still point at (a proposal lineage, a
planned run, a task envelope or a lease). They are kept, not purged and not
faulted on, because the runtime class is refused (`purgeTrashedRecords`,
`tasks/trash.ts`). Restoring the batch, or a later runtime retention rule, is
what releases them. The purge also removes the purged tasks' comments
(`commentsPurged` counts them) and revokes the record-scoped grants on every
task and comment it removed (`grantsRevoked` counts them). The aged trash is
locked before it is purged, so a restore that commits first keeps its task.

`task.restore` answers with `detail` `{ batchId, restored, restoredIds }`:
`restored` is a count and `restoredIds` names the restored tasks. A parent
outside the batch is locked `for share` for the parent check (`restoreBatch`,
`tasks/trash.ts`), so a concurrent trash of it either takes the restored child
into its own batch or makes the restore refuse `PARENT_TRASHED` 409. This holds
for a trash of any task above the parent as well as of the parent itself,
because `trashSubtree` locks each row it walks and walks again until nothing
new appears. A restored task whose parent is live outside the batch takes that
parent's board, and so do the batch's rows below it.

The `task.reparent` and `task.purge` checks run as their handlers' first
check and the rest in `parseRequest`, so the refusal is registered and audited
like any other command refusal.
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
(`tests/commands/placement-operands.test.ts`). A `parentId` string that is not an
identifier is the envelope's `NOT_FOUND` (`refuseMalformedIdentifier`,
`commands/prepare.ts`). The five owning operations (`task.assign` and the rest)
joined next: their rows take `fields` as a map, so `parseRequest` refuses an
absent, null, string or array `fields` naming `fields` and nothing is written. An empty map stays
`FIELD_UNKNOWN` (`tests/commands/owning-operation-fields.test.ts`).
On the agent prefix, `task.read` does not go through `reads/dispatch.ts`. A
`recordId` that is present and not a string is refused before any authority,
in the person prefix's bytes. That is `FIELD_VALUE_INVALID` 422 naming
`recordId` on `task.read` (the read catalogue's own `parse`) and `NOT_FOUND` 404
on `task.comment` (`recordIdOperand` in `commands/agent-operations.ts`,
THERMO-RECHECK-2 NNA1). Under a live delegation an absent one is `NOT_FOUND` 404. The check falls back to the delegation's own task, and the row serves only
the task the check was made on (`namedTaskId` in `commands/agent-authority.ts`).

## Who is calling

`Authorization: Bearer <GoTrue access token>`. The adapter verifies the ES256
signature and `exp` against GoTrue's published key set
(`<GOTRUE_URL>/.well-known/jwks.json`, or `SUPABASE_KEY_SET_URL`) and takes
`sub` as `VerifiedSubject { provider: 'supabase', subject }`. The API holds no
secret that can make a token.

A browser holds no token (S0-6c). It posts the token once to
`POST /api/session`, which verifies it and answers `{ ok: true, session }`.
It sets the token as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie scoped to
`/api/b/`, one per sign-in, named from `session` (a digest of the token, not a
secret). Its `Max-Age` is what is left of the session's 12-hour absolute limit
from the first sign-in (below), never more than the 12 (`cookieMaxAge`, C58).
A token past the limit gets no cookie, and a cookie whose token is past it is
`AUTH_SESSION_EXPIRED` 401. A request that carries the cookie needs
`x-ops-astro-csrf: 1` and no cross-site `Sec-Fetch-Site`, or it is
`AUTH_CROSS_SITE` 403. The API reads only the cookie of the sign-in the
request's `x-ops-astro-session` names. Session cookies with none named are
`AUTH_SESSION_MISMATCH` 403. `/api/session/end` clears only the named
sign-in's cookie, so a late sign-out ends no other. When that cookie's token
verifies and names a provider session, it first ends that session for every
business (below) and asks the provider to sign it out (`scope=local`). A
bearer beside it, or a forged or lapsed token, ends nothing but the cookie,
and the answer is `{ ok: true }` whatever the provider says. A bearer is read
first.

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

**Sessions (C58).** A session has no idle limit and an absolute limit of 12
hours from the first sign-in, `SESSION_ABSOLUTE_SECONDS`
(`core-records/src/identity/verified-subject.ts`), set there and nowhere else.
The first sign-in is the earliest `amr` first-factor time GoTrue stamps, which a
refresh carries unchanged, so a later re-sign-in in the same session never
extends the 12; never `iat`, which every refresh moves. A verified bearer
one second past the limit, with no first-sign-in time, or with one more than a
minute ahead of the server's clock, is `AUTH_SESSION_EXPIRED` 401
(`pastAbsoluteLimit`). A session left alone for hours inside the 12 is still
served.

A session is GoTrue's `session_id` claim, read by the verifier only when it is
a UUID (`VerifiedSubject.sessionId`), and kept by every refresh. A session the
person has ended (signed out of, ended from another session, or ended by a
factor change) is refused at login resolution from that commit,
`AUTH_SESSION_EXPIRED` 401, before the second-factor check, whatever the
token's own `exp` says. The ending holds in every business the login reaches,
whichever route asked (`ops.ended_provider_sessions`, 0061; each business's
own record is `ended_sessions`, 0057). Ending the other sessions, or a factor
change, also ends every session of the login but the kept one in every
business, seen here or not: a token whose first sign-in (`amr`) is at or
before that ending, or within the minute the provider's clock may run ahead
of the database's (`SIGN_IN_CLOCK_SKEW_SECONDS`), is refused; a sign-in after
that is served (`ops.ended_subject_sessions`, 0063, keyed by a SHA-256 digest
of the subject). So a sign-in in the minute after the ending is refused once. The provider's sign-out, which revokes
the refresh tokens, comes after and cannot undo it. A sign-out this business refuses (it no
longer admits the person) still ends the verified token's own session in
every business and at the provider, and answers the refusal.

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
`tests/runtime/storage-backstop-migrations.test.ts`). The resolver's refusal stays
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
returns it with the app's business resolver. Every answer under `/api`, a
refusal, a fault and a missing route included, carries
`Cache-Control: private, no-store`, because Vercel's edge network serves the
API (`S0-6 no edge caching`, `tests/api/api-answers-never-cached.test.ts`).
`composeApi` reads no environment, opens no socket and starts no process.
`main()` runs only as the process entry (`import.meta.main`). It reads the
environment, calls `composeApi`, runs restart recovery through that same
resolver, and only then binds the port.
`apps/api/function.ts` is the Vercel function entry. It builds the same
`composeApi` from the function's settings, with no identity route or live
channel, since those belong to a long-running process. It owns recovery:
before a request it runs the reconciliation pass for each business
`RECOVERY_BUSINESS_KEYS` names, which a named environment (`OPS_ENVIRONMENT`)
must set, if only to `none`. It has no admin login. It reads the business key
on `DATABASE_LOOKUP_URL`, a login in the lookup identity (migration 0046), and
with that unset refuses every key. It refuses to start with
`DATABASE_ADMIN_URL` set. It answers only requests whose `Host` and URL both
name `SERVED_HOST`, the environment's own host. Any other, a deployment's
generated address included, is refused 421 before anything is read, so a
promotion leaves the previous deployment serving nothing
(`tests/api/function-entry.test.ts`).
Tests build the server with `composeApi` (`compose` in `tests/api/fixture.ts`),
so they run the wiring the server listens with rather than a copy of it. A
test that hands the boundary its own executor or recorder calls `createApi`
directly.

`main()` also starts the credential broker (AW-01) when all four of
`MODEL_BROKER_CREDENTIALS_FILE`, `MODEL_BROKER_DESTINATIONS`,
`MODEL_BROKER_ROUTES` and `MODEL_BROKER_INSTALLATION` are set
(`brokerSettings` and `startModelBroker`, `apps/api/model-broker.ts`): custody's
own process, forked with only its credential file and destination list, and
the `model.call` executor over it, handed to `composeApi` as
`executeModelCall`, and the conversation exchange over the same broker as
`answerConversation` (below). None set is no broker, and `model.call` answers
`DEPENDENCY_NOT_LANDED` 501. Some of them, or a malformed one, stops the server
with a problem naming the setting, never its value. The model operations and
their adapters are registered in code there, not configured: the replay
provider is the only one until the real-provider run. Each route in
`MODEL_BROKER_ROUTES` declares its `ceiling`, a whole number of at least 1:
the calls in flight on that route across every business of the installation,
at most (the fair share, "The model call" below).
Two more settings stop the server at start: a `local` route any of whose
operations sends to a destination that is not a loopback address, and a plain
http destination off this machine. The route that carries a call is the
eligible route itself, never another found by its key.

`main()` starts the diagnostic trace export (AW-13, `apps/api/trace-exporter.ts`)
only when `TRACE_EXPORT=on`, the one change an operator makes once
`TRACE_EXPORT_ORIGIN` (the target's bare origin, https unless it is
`127.0.0.0/8` or `[::1]`: plain http would carry the key pair in clear), `TRACE_EXPORT_CREDENTIALS_FILE`
(custody's file for the target's key pair) and `TRACE_EXPORT_KEY_FILE` (the
trace key, at least 32 bytes as hex, in a file no group or other may read)
are staged. Unset or `off`, none of the three is read and the log says
`api: trace export off`. `on` with any of them missing or malformed, or any
other value, stops the server before it listens with a problem naming the
setting, never its value. The exporter's custody starts before the port is
bound; the export then runs every 30 seconds and trace retention every hour
over the recovered businesses (`RECOVERY_BUSINESS_KEYS`), beside the sweep, and
nothing on the wire reaches either
([RUNTIME.md](RUNTIME.md#the-diagnostic-trace-export)).

## Task, board and people operations

The everyday task writes, and the two reads the web's board and task page
use. Each is a row of `COMMAND_SURFACE` (`core-wire/src/surface.ts`), so its route is
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

A uuid is one identifier however it is cased; handlers compare the lower-case
form. The database's uuid cast takes either case.
Where a handler compares ids as strings it lower-cases them first:
`task.cancel` and `task.restart` (`lineageOnTask`,
`commands/tasks-controls.ts`), `task.decide` (`decide`,
`core-runtime/src/decide.ts`), a person field on the owning operations
(`refusePersonNotHere` and `canonicalPersonLinks`, `commands/tasks-state.ts`)
and the agent's one-task check (`namedTaskId`), and `task.rank` its
`afterId` and `beforeId` (`rankTask`, `commands/tasks-place.ts`).

| Operation                                                                             | Route                                                  | Body                                                                                                                                                                 | Refusals it adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.create`                                                                         | `/task/create`                                         | `operationId`, `fields`, `parentId?`, `board?`, `boardSection?`, `stateKey?`, `conversationId?`                                                                      | `FIELD_VALUE_INVALID` 422 (`fields` not an object, or a value of the wrong type, or `parentId`, `board` or `boardSection` present and neither a string nor `null`), `SOURCE_SPOOFED` 403 (`source`, `intake_state`), `FIELD_UNKNOWN` 422, `TRANSITION_PROTECTED` 422 (naming `state=task.complete` for a `stateKey` in the completed category, which only `task.complete` reaches), `PLACEMENT_IS_DERIVED` 422 (`board_rank` in `fields`; `board` or `board_section` in `fields`, which are sent as the `board` and `boardSection` operands; a `boardSection` on a subtask), `NOT_FOUND` 404 (naming `parent`, `board` for a board not live here, or `state` for a `stateKey` not installed), `PARENT_TRASHED` 409. `stateKey` is optional and names an installed state's key. `parentId` and `board` are stored lower-case. `conversationId?` names the caller's own conversation the task is created from (AW-03): its creation audit event records it as the origin, and the conversation's wrap-up counts the task; another person's, another business's, a purged or a made-up one is `NOT_FOUND` naming `conversationId`                                               |
| `task.update`                                                                         | `/task/update`                                         | `operationId`, `recordId`, `expectedRevision`, `fields`                                                                                                              | `FIELD_UNKNOWN` 422, `TRANSITION_PROTECTED` 422 (a field another operation owns, or a board change), `FIELD_VALUE_INVALID` 422 (also naming `fields` when it is not an object), `SOURCE_SPOOFED` 403, `PLACEMENT_IS_DERIVED` 422 (`board_rank`, which `task.rank` owns; `board_section` on a subtask)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `task.start`, `task.complete`                                                         | `/task/start`, `/task/complete`                        | `operationId`, `recordId`, `expectedRevision`                                                                                                                        | `TRANSITION_NOT_PERMITTED` 409 when the task is already in that state, and on `task.start` also when the task is completed: reopen it first, with a reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `task.reopen`                                                                         | `/task/reopen`                                         | `operationId`, `recordId`, `expectedRevision`, `reason`                                                                                                              | `TRANSITION_NOT_PERMITTED` 409 unless the task is completed, `FIELD_VALUE_INVALID` 422 naming `reason` when it is absent, blank, not a string or longer than 500 characters (`reason` is required, 1 to 500 characters), before anything is written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `task.set_state`                                                                      | `/task/set_state`                                      | `operationId`, `recordId`, `expectedRevision`, `stateId` (the id of one of the business's own task states, as `task.read` names them)                                | `NOT_FOUND` 404 naming `stateId` for a state not this business's (another business's and a fabricated id answer alike); `TRANSITION_NOT_PERMITTED` 409 naming the state's key for a completed target (completion is `task.complete`), for a completed task (reopen it first, with a reason) and for the state the task is already in. `task:write` on the record. Answers `detail.state`, the key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `task.duplicate`                                                                      | `/task/duplicate`                                      | `operationId`, `recordId` (the old task), `client` (an id, or `null` for none), `title`, `stepNames` (a list of at most 200 names, `[]` for none), `confirmCarried?` | `FIELD_VALUE_INVALID` 422 naming `title` or each `stepNames.<i>` that is blank, over 500 characters or not storable text, or `stepNames` when it is not a list or longer than 200; `NOT_FOUND` 404 for an old task not live in this business or a chosen client that is not one of its clients (another business's and a fabricated id answer alike); `SCOPE_NOT_GRANTED` 403 without `task:read` on the old task or `task:write` at the chosen client (the business for `null`), or without `task:share` at the chosen client when it differs from the old task's (`null` and a client differ); all asked with the caller's task grants held for share, and the refusal writes nothing; `CARRIED_TEXT_NAMES_CLIENT` 409 naming each carried field that names the old task's client by its name in the client model (folded for case, width, spacing and format characters), until `confirmCarried: true`; the refusal names fields only, never the name matched. Person only. Writes a task of the old task's type with the title and client, one subtask per step name and a `duplicated_from` link; the old task is untouched. Answers `detail: { taskId, key }` (MP-4-8) |
| `task.assign`, `task.triage`, `task.set_stage`, `task.set_party`, `task.set_audience` | `/task/assign` and so on, one per name                 | `operationId`, `recordId`, `expectedRevision`, `fields`                                                                                                              | `FIELD_UNKNOWN` 422 (also for an empty `fields`), `TRANSITION_PROTECTED` 422 for a field the operation does not own, `FIELD_VALUE_INVALID` 422 (also naming `fields` when it is absent, null, a string or an array), `NOT_FOUND` 404 naming a person field, or naming `agent` for a delegation that is not the assigner's own; for `agent`, `DELEGATION_NOT_LIVE` 403 and `DELEGATION_OUT_OF_PURPOSE` 403, and `FIELD_VALUE_INVALID` naming `agent` and `assignee` together                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `task.set_scores`                                                                     | `/task/set_scores`                                     | `operationId`, `recordId`, `expectedRevision`, `fields`                                                                                                              | `FIELD_VALUE_INVALID` 422 naming each mark that is not a whole number from 1 to 10 or null, `TRANSITION_PROTECTED` 422 for a field it does not own (MP-4-9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `task.set_adhoc`                                                                      | `/task/set_adhoc`                                      | `operationId`, `recordId`, `expectedRevision`, `fields`                                                                                                              | `FIELD_VALUE_INVALID` 422 when `ad_hoc` is not true or false, `TRANSITION_PROTECTED` 422 for a field it does not own (MP-4-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `task.set_category`                                                                   | `/task/set_category`                                   | `operationId`, `recordId`, `expectedRevision`, `fields`                                                                                                              | `FIELD_VALUE_INVALID` 422 naming `category` when it is not one of the nine `TASK_CATEGORIES` ids or null (null clears it), `TRANSITION_PROTECTED` 422 for a field it does not own, `VERSION_STALE` 409 at a stale revision (MP-4-8, CS-4.16)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `task.share_with_client`, `task.revoke_client_share`                                  | `/task/share_with_client`, `/task/revoke_client_share` | `operationId`, `recordId`, `expectedRevision`                                                                                                                        | `SCOPE_NOT_GRANTED` 403 without `access:share`, `FIELD_VALUE_INVALID` 422 naming `client` when the task has no client or nobody stands on it (share only), `NOT_FOUND` 404 for a trashed task (share only) (MP-4-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `time.start`, `time.stop`                                                             | `/time/start`, `/time/stop`                            | `operationId`, `taskId`                                                                                                                                              | `SCOPE_NOT_GRANTED` 403 without `time:write`, `NOT_FOUND` 404 for a task the caller may not read or that is not here; `time.start` `TRANSITION_NOT_PERMITTED` 409 naming `timer` while the caller's timer runs anywhere; `time.stop` `NOT_FOUND` 404 naming `timer` when none of the caller's runs on that task (MP-4-6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `time.log`                                                                            | `/time/log`                                            | `operationId`, `taskId`, `duration`, `note?`                                                                                                                         | as `time.start` for the task, `FIELD_VALUE_INVALID` 422 naming `duration` unless it is text such as "1h 30m", "90m" or "90" from one minute to a day, and naming `note` unless it is text of at most 2,000 characters (MP-4-6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `time.set_note`, `time.delete`                                                        | `/time/set_note`, `/time/delete`                       | `operationId`, `entryId`, `note` (set_note)                                                                                                                          | `SCOPE_NOT_GRANTED` 403 without `time:write`, `NOT_FOUND` 404 unless the entry is the caller's own and live, `FIELD_VALUE_INVALID` 422 naming `note`; `time.delete` `TRANSITION_NOT_PERMITTED` 409 naming `timer` while the entry runs (MP-4-6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tag.create`                                                                          | `/tag/create`                                          | `operationId`, `name`                                                                                                                                                | `SCOPE_NOT_GRANTED` 403 without `tag:write`, `FIELD_VALUE_INVALID` 422 naming `name` unless it is text of 1 to 40 characters after trimming with no control character, `UNIQUE_VALUE_TAKEN` 422 naming `name` when the business has it in any case; the answer's `detail` carries `tagId` and `name` (MP-4-11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `task.add_tag`, `task.remove_tag`                                                     | `/task/add_tag`, `/task/remove_tag`                    | `operationId`, `recordId`, `tagId`                                                                                                                                   | `SCOPE_NOT_GRANTED` 403 without `write` on the task, `NOT_FOUND` 404 for a task that is not here and naming `tagId` for a tag not in this business's vocabulary (remove: or not on the task), `UNIQUE_VALUE_TAKEN` 422 naming `tagId` when the task already carries it (add) (MP-4-11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `task.reparent`                                                                       | `/task/reparent`                                       | `operationId`, `recordId`, `expectedRevision`, `parentId` (or null)                                                                                                  | `FIELD_VALUE_INVALID` 422 naming `parentId` when it is absent or neither a string nor `null`, `PLACEMENT_IS_DERIVED` 422 (its own parent, or any of its descendants), `SCOPE_NOT_GRANTED` 403 when the caller may not write the new parent (asked before the parent is looked up), the board it brings or a live descendant that moves board with it (a business grant covers all), `PARENT_TRASHED` 409, `NOT_FOUND` 404. The task's live descendants move to the new board with it. `parentId` compares case-insensitively and is stored lower-case. The derived board is compared with the task's own case-insensitively, as `task.move` compares it: a reparent within the board the task is already on asks nothing about the board, carries nothing to the subtree and keeps the stored spelling (R5-THERMO-2 = R5-AUTHORITY-4)                                                                                                                                                                                                                                                                                                                                        |
| `task.move`                                                                           | `/task/move`                                           | `operationId`, `recordId`, `expectedRevision`, `board`, `boardSection?`                                                                                              | `PLACEMENT_IS_DERIVED` 422 (a section on a subtask; naming `board` for a subtask, whose board is its parent's), `FIELD_VALUE_INVALID` 422, `SCOPE_NOT_GRANTED` 403 when the caller may not write the destination board (asked on the board's record, before the board is looked up; a business grant covers every board) or a live descendant, `NOT_FOUND` 404 naming `board`. The task's live descendants move with it; a task moved to another board ranks after that board's last task, and a section change within its board keeps its rank. `board` compares case-insensitively on both sides, the sent one and the stored one: a move to the task's own board in any case keeps the stored spelling and makes no re-rank and no carry, even for a board stored in upper case before sent boards were lower-cased; a move to another board stores it lower-case                                                                                                                                                                                                                                                                                                         |
| `task.rank`                                                                           | `/task/rank`                                           | `operationId`, `recordId`, `expectedRevision`, `afterId?`, `beforeId?`                                                                                               | `FIELD_VALUE_INVALID` 422 naming `afterId` or `beforeId` when present and neither a string nor `null`, `SCOPE_NOT_GRANTED` 403 when the caller may not write a neighbour (asked before it is looked up), `PLACEMENT_IS_DERIVED` 422 when neither neighbour is sent (naming `board_rank`) and naming `neighbour` when a neighbour is the task itself, both name one task, they are out of order, they are not adjacent (another live sibling sits between them: read the list again) or there is no rank left between them, `NOT_FOUND` 404 naming `neighbour` when one is not a live sibling (same parent, or top level on the same board). With only `afterId` the task goes directly after it, and likewise before `beforeId`; `afterId` and `beforeId` compare case-insensitively, so a uuid in either case names one task                                                                                                                                                                                                                                                                                                                                                |
| `task.trash`                                                                          | `/task/trash`                                          | `operationId`, `recordId`, `expectedRevision`                                                                                                                        | `SCOPE_NOT_GRANTED` 403 when a live descendant is not covered (below); the answer's `detail` carries `batchId`, which `task.restore` takes, and `trashed`, the count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `task.board`                                                                          | `/task/board`                                          | `board`, required: a board id, or `null` for the unboarded tasks                                                                                                     | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404 for a board not live here and for an external party, `FIELD_VALUE_INVALID` 422, `FIELD_NOT_WRITABLE` 422; answers `{ ok: true, tasks, changedAt, viewer, owed }`, with `withheld` for a collection-wide reader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `person.list`                                                                         | `/person/list`                                         | `{}`; it takes no fields                                                                                                                                             | `SCOPE_NOT_GRANTED` 403 without `read` on `person`, `FIELD_NOT_WRITABLE` 422; answers `{ ok: true, persons: [{ personId, name }] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tag.list`                                                                            | `/tag/list`                                            | `{}`; it takes no fields                                                                                                                                             | `SCOPE_NOT_GRANTED` 403 without `read` on `task` across the business (a reader held to one client's records included); answers `{ ok: true, tags: [{ id, name }] }`, by name (MP-4-11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `task.todos`                                                                          | `/task/todos`                                          | `{}`, or one scope: `{ person }` or `{ client }`, each a uuid (MP-7-2)                                                                                               | `SCOPE_NOT_GRANTED` 403 without `read` on `task` across the business (a reader held to one client's records included); `FIELD_VALUE_INVALID` 400 for both scopes or a malformed id; `NOT_FOUND` 404 for a person who is no active member here or a client that is not one of this business's (another business's and a made-up id alike); answers `{ ok: true, todos: [...] }`: the reader's own open tasks on any board, a teammate's (`person`) or every one under a client (`client`), each a task summary with `tags` and `waitingComments` (MP-7-1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `task.ledger`                                                                         | `/task/ledger`                                         | `timeZone`, `before?`, `query?`                                                                                                                                      | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404 for an external party and for a member who is not internal (the shared view carries no history), `FIELD_VALUE_INVALID` 422 naming `timeZone`, `before` or `query`, `FIELD_NOT_WRITABLE` 422; answers `{ ok: true, days, earlier }`: up to seven days in the reader's zone, newest first, each with its applied task writes newest first (reads, refusals, replays, `task.heartbeat` and trashed tasks left out), and whether an earlier day has any; with `query`, only the events of the tasks C1's `searchTasks` finds, up to its bound of 500 best, and `more` when the reader's own matches go past it (MP-8-4, `reads/ledger.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `team.list`                                                                           | `/team/list`                                           | `{}`; it takes no fields                                                                                                                                             | `SCOPE_NOT_GRANTED` 403 without `read` on `person`, `NOT_FOUND` 404 for a client of the business (the Team panel is staff only, MP-7-10); answers `{ ok: true, you, people: [{ personId, name, availability }] }`, `you` the reader's own person, staff only, `availability` null or `{ state, reason }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `account/availability` (person prefix only; not a surface command)                    | `/account/availability`                                | `state`, `'available'` or `'away'`; `reason`, 1 to 140 characters, away only                                                                                         | the person's own row, named by the session and never the body; `COMMAND_BODY_INVALID` 400 for any other field, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404 for a client; no agent route; audited as `availability.set` with its row in one transaction, and a refusal of a signed-in person audited refused; answers `{ availability }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`task.assign` takes the `assign` action, `task.set_party` and
`task.set_audience` take `share`, and every other write here takes `write`, all
on `task` (their `COMMAND_SURFACE` rows). The three reads take `read`: the board
and the ledger on `task`, the list on `person`. A rank is always placed between neighbours and never sent as a
number. The handlers are the cases of the same name in `commands/handlers.ts`
and `reads/dispatch.ts`; the manifest below cites each one. On the agent prefix
all of these answer `DELEGATION_EXCLUDES_OPERATION` 403.

**Assign to AI.** `task.assign` sets a task's assignee to a person
(`assignee`) or to an agent (`agent`, a delegation id, migration 0082), one
kind at a time: either clears the other, and unassigning (`assignee: null`)
clears both. Only the delegation's own person
assigns it (another person's, a manager's included, is `NOT_FOUND`, as an
unknown id is), and only while it is live and minted for this very task. The
delegation row is read `for share` under the task lock, so a racing revoke
is seen or waits. Any revoke, explicit or by the runtime, clears the
delegation from every task holding it (tasks only), one applied `task.assign`
audit event per task, in the revoke's own transaction. Four eyes counts an
agent assignee as its delegating person. `task.read` answers `agent` (the
delegation, its purpose, the accountable person and whether it is live) to
that person only, null to every other reader, and `myAgents` (the reader's own
live delegations for this task); an agent reader is sent neither. Assignment
starts no run.

**A task an agent holds is completed after review** (MP-4-15, BOARDS P-30).
`task.complete` on a task whose `agent` is set moves it to the business's
unstarted state (Needs review, where a person confirms the agent's work),
answering `detail.state` with that key and `completedAt` null, with no step
archived; on a task already in the unstarted state it completes as any task.
The board tick, the status select and the Projects panel's tick all send
`task.complete`, so they agree. The answer names the state only, never the
agent. An agent never sends `task.complete`.
`tests/commands/task-complete-agent.test.ts` holds the cases and the three
crossings.

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
the prober's own audit (`UNPRODUCED_CODES`, `core-records/src/register.ts`).

**`task.board` answers what the caller's grants reach.** A member holding
`task:read` on the whole collection gets every task and `withheld`, how many
of the board's tasks their grants do not reach, never which (B-22, the
withheld count of 14 September 2026); that grant reaches every task, so it is
0 today. A member holding `task:read` only on some tasks is admitted too (the
row's `declared-within` authority, `reads/dispatch.ts`) and gets those tasks,
filtered inside the query by `readableScope`
(`core-records/src/authority/grants.ts`), and no `withheld` at all: such a
member is a client login under owner answer 22, and other clients' tasks are
never counted for them. An external party is never admitted this way: its
share opens the shared task, and the board stays `NOT_FOUND` with no count.
Another business's tasks are neither listed nor counted. Every admitted
answer carries `changedAt`, when the newest task served last changed (the
board's freshness stamp, MP-5-7), or `null` when none is served. It comes
from the same query as the tasks, so a newer task the caller cannot read, on
another client's work or in another business, never moves it; no refusal
carries it. `tests/reads/mp-5-board-isolation.test.ts` holds it, across three
crossings.

Each row `task.board` answers is the task's summary with what the Projects
board's cells draw (MP-5-8): `rank`, `stage` and `clientSet`. The stage and
the client mark are the stored slots. The rank is worked out at read
(`reads/board-rank.ts`, with MP-4-9's derivation) over the open tasks in the
caller's scope, the same scope the one grant read admitted the board with, so
a task's #N on the board is its #N on its page; a step archived by its
parent's completion is not open (MP-4-15). `tests/reads/mp-5-8-board-columns.test.ts`
reads each row's rank, stage and client mark back against `task.read` and
holds the crossings; `mp-5-8-board-rank-steps.test.ts` reads an archived
step back.

Each row also carries `client` (the Clients row door): the task's client as
`{ clientId, name }`, by `task.read`'s and `client.list`'s rule, so only where
the caller's grants reach that client (a grant across the business, or one on
the client). A task under a client the caller does not reach reads `null`
beside `clientSet: true`, never the id or name `client.list` withholds; a task
under none reads `null`. Asked only of the rows served
(`commands/task-content.ts` `withBoardClients`). The Projects board names its
Client column and facet from it, and a Clients row door opens
`/projects/?f=client:"<name>"`. `tests/reads/board-row-client.test.ts` reads it
back against `task.read` and `client.list` and holds the crossings: another
business, another client, a task holder without the client, and the agent.

Each row also carries `actualMinutes` (MP-5-8's Actual column): every
finished minute logged on the task (MP-4-6), summed at read over the rows
served (`reads/board-time.ts`), the total `task.read`'s `time` answers: one
number, no names. It is 0 for a task with no time; a running timer adds
nothing until it stops. `tests/reads/mp-5-8-board-actual.test.ts` reads it
back and holds the crossings.

Each row also carries `estimateMinutes` (MP-4-8, the Estimates column and the
burn bar's measure) and `pageLink` (MP-4-12, where the row's hover door goes),
each the task's own stored value as `task.read` answers it, null when not set.
`tests/reads/mp-5-8-board-estimate.test.ts` reads both back and holds the
crossings.

Each row also carries `category` (MP-4-8, CS-4.16): the id `task.set_category`
stored, null for none, as `task.read` answers it; the board draws it as its
label (`TASK_CATEGORIES`) on the category chips.
`tests/commands/task-set-category.test.ts` reads it back.

Each row also carries `statePosition` (MP-5-11): the `position` of the
task's state record, read in the same join as the state, so the Projects
board groups its rows in the workflow's order and a reordered workflow is the
next read's order. It is null for a task with no state. It is the row's own
business's state, so another business's workflow never moves it, and a
caller is shown the positions of only the states their readable rows are in,
never the whole vocabulary. `tests/reads/mp-5-11-board-status-order.test.ts`
holds the order and the three crossings.

Each row also carries `waitReason` (MP-5-11): why the task waits, from the
run lifecycle. It is `needs_approval` while the task has a gate that is
pending, not expired, on a version not superseded, whoever may decide it, and
null otherwise; the Projects board prints "approval" after that group's
heading. `tests/reads/mp-5-11-board-wait-reason.test.ts` holds the reasons
and the three crossings.

Each row also carries `awaitingDecision` (MP-5-12): true when the task waits
at such a gate and the caller's decide grant reaches the task, the grant
`task.decide` checks. The decide reach comes from `readableScope` with action
`decide`, and the gates are read only for the rows already served
(`awaitingApproval`, `reads/awaiting.ts`), so a gate on a task the caller
cannot read is never read or counted. The Projects board's Review mode draws these rows and counts
them. `tests/reads/mp-5-12-board-review.test.ts` holds the count and the three
crossings.

Each row also carries `agent` and `myAgents` (Assign to AI), the values
`task.read` sends the same reader for that task: the delegation holding the
task only when it is the reader's own, and the reader's own live delegations
minted for it. They are read only for the rows already served
(`reads/board-agents.ts`), so a delegation on a task the caller cannot read
is never looked at, and another person's is never sent. An agent does not
read the board. `tests/reads/board-agents.test.ts` holds the three crossings.

Each row also carries `comments` (MP-5-8's comment badge, P-22): of the
reader's own open inbox items (INB-1) about that task, `client` counts those
of reason `client_comment` and `mentions` those of reason `mention`, and
`latest` is when the newest of them was raised, null when there are none.
They are counted in one query only over the rows already served
(`reads/board-comments.ts`), with the reader as the recipient, so an item
about a task the caller cannot read is never looked at, and another person's
items are never counted, even on a task both read. Every admitted answer
also carries `owed`: the caller's owed count, INB-1's one permission-checked
count, the number `inbox.count` gives the same caller, which the Review mode
shows (MP-5-12). `tests/reads/board-comments.test.ts` holds the counts and
the three crossings.

Every admitted answer also carries `viewer` (MP-5-12): the caller's own person
id, taken from the session, which the Projects board's viewer preset narrows
to. It is never another person's identifier, and no refusal carries it. The
same suite holds it for a collection reader, a record-scoped reader and
another business's member.

## The operations L2 made possible

Four rows joined the surface when L2's model modules landed, and one came off
the pending list. Each reaches the API and the command line by generation, with
no route written by hand.

| Operation                                  | Route                                        | Body                                                                                                        | Refusals it can answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.comment`                             | `/task/comment`                              | `operationId`, `recordId`, `expectedRevision`, `body`, `audience`, `commentType?`, `parentId?`, `mentions?` | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422 (naming `body` when it is absent, blank or holds a NUL or an unpaired surrogate, or `audience`, `comment_type` or `mentions`; naming `parentId` for a parent that is not a live top-level message on this task, or `audience` for a reply outside its message's audience), `AUDIENCE_NOT_PERMITTED` 422 (an external party writing `internal`; the agent prefix writing `client`), `MENTION_NOT_READABLE` 422 (per unreadable mention, named only where its author sees it; none saved), `NOT_FOUND` 404, `VERSION_STALE` 409, `DEPENDENCY_NOT_LANDED` 501 where a business has no comment type |
| `task.edit_comment`, `task.delete_comment` | `/task/edit_comment`, `/task/delete_comment` | `operationId`, `recordId`, `expectedRevision`, `commentId`, `body` (edit only)                              | `SCOPE_NOT_GRANTED` 403 without `task:comment` on the task, or naming `commentId` when the caller did not write it; `NOT_FOUND` 404 for a comment not live on this task; `FIELD_VALUE_INVALID` 422 naming `body` (edit only) (MP-4-5)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `preset.plan`                              | `/preset/plan`                               | `recordTypeKey`, `presetKey`, `fields[]`                                                                    | `FIELD_VALUE_INVALID` 422 for an absent or mistyped operand, `SCOPE_NOT_GRANTED` 403, `PRESET_FIELD_UNCLASSIFIED` 422, `PRESET_TYPE_UNKNOWN` 404, `PRESET_FIELD_UNPLACEABLE` 409, `PRESET_FIELD_DUPLICATE` 422                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `settings.set_four_eyes_threshold`         | `/settings/set_four_eyes_threshold`          | `operationId`, `value` (number or `null`), `expectedRevision?`                                              | `SCOPE_NOT_GRANTED` 403 (it asks `spend:decide`), `STEP_UP_REQUIRED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422 (`value`, or an `expectedRevision` that is not a whole number), `NOT_FOUND` 404                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `settings.set_client_sign_off`             | `/settings/set_client_sign_off`              | `operationId`, `value` (boolean), `expectedRevision?`                                                       | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422 (`value`, or an `expectedRevision` that is not a whole number), `NOT_FOUND` 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `settings.set_money_step_up`               | `/settings/set_money_step_up`                | `operationId`, `value` (boolean), `expectedRevision?`                                                       | `SCOPE_NOT_GRANTED` 403, `STEP_UP_REQUIRED` 403 (switching it off), `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422 (`value`, or an `expectedRevision` that is not a whole number), `NOT_FOUND` 404                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `settings.set_conversation_window`         | `/settings/set_conversation_window`          | `operationId`, `value` (whole days), `expectedRevision?`                                                    | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422 (`value`, or an `expectedRevision` that is not a whole number), `NOT_FOUND` 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `settings.set_retention_window`            | `/settings/set_retention_window`             | `operationId`, `value` (whole days), `expectedRevision?`                                                    | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422 (`value`, or an `expectedRevision` that is not a whole number), `NOT_FOUND` 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

A settings `value` of any other type, including a string, an object or an
array, is `FIELD_VALUE_INVALID` naming `value` before any write
(`setBusinessSetting`, `commands/settings-write.ts`), so nothing a jsonb column
cannot hold reaches `business_settings`.

`task.comment` writes a comment record beside the task and leaves the task's
own revision alone, so a caller may keep writing against the revision they
hold. The author is the acting actor and the posting time is the server's;
neither is a payload field. `mentions` lists person ids. Each person
mentioned is raised an inbox item in the same transaction (INB-1). If one of
them cannot read the task, or is an outside party named in an `internal`
comment, the whole comment is refused before it saves. The register keeps
that refusal naming each person by the identifier as sent, so a replay names
nobody the author may no longer see.

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
An `expectedRevision` that is not a whole number is `FIELD_VALUE_INVALID` 422
naming `expectedRevision`, and nothing is written; `VERSION_STALE` is for a
whole-number revision the row has moved past (`writeBusinessSetting`,
`records/business-settings.ts`).
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

Every operation in `COMMAND_SURFACE` is built. The one `DEPENDENCY_NOT_LANDED`
a command answers for a missing part is `task.comment` on a business with no
comment record type.

| Operation       | Route            | Body                                                                                                                                                                                                                                                                                                                   | Refusals it can answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.propose`  | `/task/propose`  | `operationId`, `recordId`, `expectedRevision`, `purpose`, `maximumMinor`, `currency`, `payload`, `step`, `expiresInSeconds?`, `lineageId?`                                                                                                                                                                             | `SCOPE_NOT_GRANTED` 403, `PROPOSAL_SCOPE_EXCEEDED` 422 (also a `currency` other than the task's cap's, which is its envelope's cap or else the business cap, or a ceiling past the cap's remaining room, or past the task's open envelope's remaining room, each less the hold the superseded version releases), `GATE_NOT_FOUND` 404, `LINEAGE_TERMINAL` 409, `LINEAGE_NOT_ON_TASK` 409, `CHANGE_ROUNDS_EXHAUSTED` 409, `VERSION_STALE` 409, `NOT_FOUND` 404 (also a trashed task, in the same bytes as a missing one, before the handler's operand checks and the revision), `FIELD_VALUE_INVALID` 422 (naming `purpose` when absent, not a string or out of shape; `currency` when absent, not a string or empty; `payload` when not a JSON object; `step`; `expiresInSeconds`; `lineageId` when neither a string nor `null`) |
| `task.decide`   | `/task/decide`   | `operationId`, `gateId`, `versionId`, `decision` (`approve`, `reject`, `request_changes`, or `escalate` at the revision bound), `note`, `recipientPersonId` (escalate's only: a holder of `decide` at business scope, not the assignee; the gate stays open and from then on only a business-scope decider decides it) | `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` 409 (escalate before the bound), `SCOPE_NOT_GRANTED` 403 naming `recipientPersonId` (a recipient outside the escalation role), `GATE_ALREADY_DECIDED` 409, `GATE_EXPIRED` 410, `PROPOSAL_SUPERSEDED` 409, `EVIDENCE_MISMATCH` 409, `LINEAGE_TERMINAL` 409, `BUDGET_UNAVAILABLE` 409, `BUDGET_EXHAUSTED` 402, `CAP_BINDING_MISMATCH` 409, `CLIENT_SIGNOFF_REQUIRED` 409 (approving a reviewed output while the business requires the client's sign-off, AW-08; nothing written), `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422 naming `gateId` or `versionId` when it is absent or not a string, `recipientPersonId` when escalate lacks one or another decision carries one, or `note` when the note is not a string or carries a NUL or an unpaired surrogate                  |
| `task.pickup`   | `/task/pickup`   | `operationId`, `reservationId`, `leaseSeconds?`                                                                                                                                                                                                                                                                        | `RESERVATION_NOT_CLAIMABLE` 409, `LEASE_HELD` 409, `BUDGET_UNAVAILABLE` 409 (a hold its spend used whole: the run stops at its budget and asks the person), `SCOPE_NOT_GRANTED` 403 (person), `DELEGATION_ALREADY_LIVE` 409 (agent), `DELEGATION_WIDENS` 403, `DEPENDENCY_NOT_LANDED` 501 (agent, no delegation key), `FIELD_VALUE_INVALID` 422, `COMMAND_BODY_INVALID` 400 (person)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `task.handback` | `/task/handback` | `operationId`, `leaseId`, `fence`, `outcome`, `report?`, `actualMinor?`, `successor?`                                                                                                                                                                                                                                  | `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `SUCCESSOR_OUT_OF_BOUNDS` 409, `ACTUAL_EXPENDITURE_UNSUPPORTED` 422, `FIELD_VALUE_INVALID` 422 (also naming `report` or `successor.<key>` when it holds a NUL or an unpaired surrogate, on both prefixes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `task.queue`    | `/task/queue`    | nothing; it is a read                                                                                                                                                                                                                                                                                                  | `SCOPE_NOT_GRANTED` 403                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**A trashed task's work is not handed out.** `task.queue` leaves it out, and
`task.pickup` of its reservation answers exactly as an unknown reservation
does: `RESERVATION_NOT_CLAIMABLE` 409 with the same two fixed sentences, and no
lease is written (`queue` and `pickup`, `core-runtime/src/pickup.ts`).
Restoring the task brings the work back.
`tests/runtime/trashed-task-work-and-notes.test.ts` holds it.

**The agent's output takes its own review round (AW-09).** A handback's
successor is a version like any other: `task.decide` on its gate, two rounds
of `request_changes`, the third `CHANGE_ROUNDS_EXHAUSTED` 409 with approve,
reject or escalate on offer, and the gate left open. A person decides it,
never the agent: on the agent prefix `task.decide` is
`DELEGATION_EXCLUDES_DECISION` 403, the agent's own login on the person
prefix resolves to no person, and the runtime refuses any deciding actor that
is not the person's own (`DELEGATION_EXCLUDES_DECISION`, RUNTIME.md). The
review page itself is visual: the command line hands off to it with
`review.view` (CLI.md, "Visual operations").

**Alerts (T2h).** A run's transition into settled, failed or cancelled, or
into a wait only a person can end, raises one alert on its task in the same
transaction: T2d's settlement (`settled`, `failed`, or `awaiting_person` with
`liability_unknown` when the cost is above the hold), a hand-back (`settled`,
`failed`, or `awaiting_person` with `needs_approval` for a successor or
`quarantined` for a kept hold) and `task.cancel` (`cancelled`). Progress
raises none. `task.read` carries a task's `alerts`, newest first, to the team
only, and `task.queue` carries every live task's beside the queue, to the team
only; an agent's queue carries none. Nothing delivers them. Each is
`{ id, taskId, kind, waitingReason, causeId, raisedAt }`, one per cause and
kind (`migrations/0036_alerts.sql`). `tests/runtime/t2h-alerts.test.ts` holds it.

**The execution graph (AW-06).** `task.execution` carries `graph` beside its
runs and page of events: `{ plan, planRecordId, planRunId, steps,
sourceRevision, complete, nodes }`, one node per run, `{ nodeId, condition,
planned, observed }`. The planned layer is the structured plan record the plan
decision bound (AW-04), and only that one (`core-runtime/src/plan-binding.ts`):
its decision approves its own gate, its gate is its run's, it was written in
the decision's transaction, and the digests of its words and record recompute
to the row's. A record failing any of these is never projected, however new or
well formed; the newest that holds is the plan, and with none `plan` is
`unbound`, `steps` empty and every `planned` null. With one, `plan` is `bound`,
`steps` lists the plan's `{ key, title, after, runIds }`, and a run proposed
under a step (`step.planStep`, below) has `planned: { key, title }`. A run
naming no step, or a key the bound plan lacks, has the condition `unplanned`
(its observed layer unchanged); the plan's own run and its lineage are the
plan, not work outside it. The observed layer is the run's own record, read in the same
statement as the events and never from the page, so a cursor never changes a
condition: `not_started`; `in_progress` with `attemptId` and `whoseMove`
(`{ kind: 'agent' | 'person', actorId }`, the lease's holder, or null actor
when anyone with the grant may move: a pickup after a drop, a budget answer);
`settled` with `outcome` (the attempt's, `cancelled`, `refused` for a rejected
gate, `expired`); `superseded` for a version replaced on its lineage; and
`unrecognised`, with the raw `runState`, for a state the projection does not
know. Silence is not a verdict: a run with no progress after its claim stays in
progress, and past its lease's expiry with no drop its `lease.state` is
`lapsed`; a drop, once recorded, shows with its `fault`. `heldMinor` and
`spentMinor` are null when nothing is held or spent, never 0, with the
version's `currency`. `effectObserved` is true only for an attempt observed or
settled: a dispatch marker (a staged intent) is not an effect. The projection
takes facts the grant-checked read already fetched and computes no authority:
every reader who may see the task gets the same bytes, and the graph is frozen
(`reads/execution-graph.ts`). Malformed facts throw before projection, so the
read answers unavailable, never an empty graph.
`tests/runtime/aw-06-observed-layer.test.ts` and
`tests/runtime/aw-06-isolation.test.ts` hold it.
Each node also carries `helpers` (AW-11, `reads/execution-helpers.ts`): the
helper agents the run's work was handed to, under any of its leases, so a
replacement parent's new helper sits beside the old one. Each is
`{ childDelegationId, helperActorId, state, outcome, refusal, fault, spentMinor, steps }`:
`working`, `handed_back` with its outcome and named refusal, or `dropped` with
the fault (`DELEGATION_EXPIRED` first, then `DELEGATION_REVOKED` or
`DELEGATION_NARROWED`), by the rule the parent's merged result uses. `steps` are
the helper's own model calls on the parent's lease,
`{ callId, operation, state, reservedMinor, spentMinor, planned, unplanned }`,
found by the caller's delegation the broker records (`0104`); they spend the
parent's one reservation, so the node's `heldMinor` and `spentMinor` already
carry them. A call carries no plan key, so each step takes its run's
placement: `planned` is the node's, and `unplanned` is true exactly when the
node reads `unplanned` (`tests/reads/aw-11-child-placement.test.ts`).
`tests/broker/aw-11-child-graph.test.ts` and its isolation suite hold it.
Each node also carries `definition` (AW-04, `reads/execution-definition.ts`):
the instruction file the run was pinned to and every file it read, or `null`
for a run with no pin. It is
`{ kind, path, versionId, digest, size, manifestDigest, reads, readSet }`:
`kind` is `bootstrap_file` (with its `path`) or `definition_version` (with its
`versionId`), `digest` and `size` are the file's identity, and
`manifestDigest` is the accept-time manifest's. `reads` is the read ledger in
read order, `{ sequence, entry, path, digest, size }`, each row written by the
read itself; `readSet` is the path-sorted set digest over them and their
distinct count (`setDigest`). The command line prints the same answer
(`tests/cli/aw-04-pin-ledger-cli.test.ts`).
A drop raises no alert (T3e2): `task.queue` carries the team's `outages`
beside the alerts, newest first, each
`{ id, cause, fault, openedAt, lastDropAt, closedAt, contentDigest, runs: [{ taskId, runId, attemptId, reactivated }] }`,
one report per outage per business; a reader outside the team gets none, and
the task page draws the report naming its task (`tests/runtime/t3e2-outage.test.ts`).
One cause is not a drop (AW-04): `audit_copy_missing`, fault `ours`, is a
pinned read's audit copy the store could not keep. The read went through; the
row is one per business and `contentDigest` (null on a drop's report), lists no
runs and stays open, a later miss moving `lastDropAt`
(`tests/runtime/aw-04-missing-audit-copy.test.ts`).

`task.propose` answers `FIELD_VALUE_INVALID` 422 for the two shapes its columns
constrain, before the write rather than at it: a `purpose` outside
`^[a-z][a-z0-9_]{0,62}$` names `purpose`, and a `step` that is not
`{ kind, payload }` with a non-empty `kind` and an object `payload` names
`step`. `step.planStep` is optional (AW-06, ORCH41 decision (a)): a step key of
the task's bound plan record, checked under the task lock; a key the plan
lacks, a key on a task with no bound plan, or a `planStep` that is not a
string is `FIELD_VALUE_INVALID` naming `step`, and nothing is written. The key
is stored on the run's step (`0105`) and shown in the evidence pack the
approver signs. Both used to reach the database and arrive as `SERVICE_UNAVAILABLE`
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
is `PROPOSAL_SUPERSEDED` rather than a decision about something the decider never
read. The refusal names the gate and the version it carries, never the version
presented, so a foreign and a fabricated `versionId` on the caller's own gate
answer the same bytes. The signing key and the budget cap are not in the body.
The key comes from the deployment's environment and the cap is the business's
own, read rather than created, because a command that created the ceiling it
then spent against could never be refused `BUDGET_EXHAUSTED`.

A gate not visible in the caller's business, foreign or fabricated, answers
`NOT_FOUND` 404 with a constant body that carries no id, and the refusal is
audited in the caller's business (`GATE_NOT_VISIBLE` in `decideOnGate`,
`commands/tasks-decide.ts`). A gate on a trashed task answers in the same
bytes, including a trash that commits while the decision waits on its locks
(`decide`, `core-runtime/src/decide.ts`). `GATE_NOT_FOUND` is no longer a `task.decide`
answer, because the handler translates the runtime's code before answering.

Three of those codes arrived with lane L4-RUNTIME-FIX and are registered here
with the statuses the runtime suggests. `LINEAGE_NOT_ON_TASK` 409 is
`task.propose` naming a `lineageId` that belongs to a different task in the
same business. The caller may hold it legitimately, and it is still not this
task's. `CAP_BINDING_MISMATCH` 409 is a decision whose version is in a currency
the task's open envelope was not opened in. It is decide's second barrier, and
no command reaches it. The cap half is not reachable, because every decision on
a business reads the same cap. Nor is the currency half: `task.propose` checks
the currency against the task's cap before the first write and refuses another
one `PROPOSAL_SCOPE_EXCEEDED` 422 (`refuseBeyondBudget`,
`core-runtime/src/propose.ts`), so no version in another currency reaches a
decision. `ACTUAL_EXPENDITURE_UNSUPPORTED` 422 is below.

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
`outcomes` is `completed`, `failed` or `dropped` (T3e1: a drop names
`report.dropCause`, `provider_unavailable` or `connection_lost`, asks for no
successor, and the same work is reserved again; anything else is
`FIELD_VALUE_INVALID` on `report`). `credential` names where the claimant's
credential travels, never the credential itself. That is the
`x-agent-delegation` header for an agent and the person's own bearer for a
person. `versionBinding` has no operand. The lease is bound to `versionId`, and the handback refuses `LEASE_NOT_OWNED`, keeping the
report, when that version was superseded or its lineage is no longer live
(`handback`, `core-runtime/src/handback.ts`). `task.handback` takes no
`expectedVersions` and no record revision; `expectedVersions.taskRevision` is
the task as read at pickup. `tests/pickup/agent-pickup-payload.test.ts`
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

A `timestamptz` value must be a real calendar date from year 1, with an hour to
23 or exactly 24:00:00, a minute and a second to 59, and a zone offset within
15:59 either way. Anything else, a leap second included, is
`FIELD_VALUE_INVALID` 422 naming the field as `key=timestamptz` (`isTimestamp`,
`commands/values.ts`).

A NUL or an unpaired surrogate in an attempted key or value is stored as its
JSON escape text (`\u0000`), because a jsonb string cannot hold it
(`storable`, `commands/audit.ts`, called by `writeAuditEvent`). The payload
digest covers the value as received. On both prefixes, a refusal name that
echoes a caller key holding such a code unit is registered as its JSON escape
text (`storable`, called by `registerAttempt` in `commands/register-store.ts`).
Both prefixes answer it in that form the first time and on replay, so the bytes
match (`settle` in `commands/envelope.ts`, which both prefixes call).

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

| Operation           | Route                | Body                                                                                                                                                                                                      | Authority                                                                                                                                                                         | Refusals it can answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grant.revoke`      | `/grant/revoke`      | `operationId`, `grantId`                                                                                                                                                                                  | `manage` on tasks, asked at the revoked grant's own scope, then the manager's own ceiling: `manage` and the grant's own pair on its collection, at a covering scope               | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` 409 (already revoked), `COMMAND_BODY_INVALID` 400 (also naming a `delegationId` sent beside the `grantId`)                                                                                                                                                                                                                                                                                                                                           |
| `delegation.revoke` | `/delegation/revoke` | `operationId`, `delegationId`                                                                                                                                                                             | as `grant.revoke`, asked at the delegation's purpose scope, over every (collection, action) the delegation reaches                                                                | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `DELEGATION_NOT_LIVE` 401 (already revoked, settled or expired), `COMMAND_BODY_INVALID` 400 (also naming a `grantId` sent beside the `delegationId`)                                                                                                                                                                                                                                                                                                                            |
| `task.cancel`       | `/task/cancel`       | `operationId`, `recordId`, `lineageId`, `reason`                                                                                                                                                          | `decide` on the task named in `recordId` (T3a; never an agent), asked again with the grants held, and `write` under the runtime's locks; a record-scoped grant is enough          | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `LINEAGE_NOT_ON_TASK` 409, `LINEAGE_TERMINAL` 409, `FIELD_VALUE_INVALID` 422 (naming `reason` when it is absent, blank, longer than 500 characters or holds a NUL or an unpaired surrogate), `COMMAND_BODY_INVALID` 400                                                                                                                                                                                                                                                         |
| `task.restart`      | `/task/restart`      | `operationId`, `recordId`, `lineageId`, `expiresInSeconds?`                                                                                                                                               | `decide` on the task named in `recordId` (T3a; never an agent), plus `propose`'s own read and write checks; closes the task's open envelope, so the next approval opens a new one | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `LINEAGE_NOT_ON_TASK` 409, `TRANSITION_NOT_PERMITTED` 409 (live, completed or already restarted), `FIELD_VALUE_INVALID` 422, `PROPOSAL_SCOPE_EXCEEDED` 422 (the restarted lineage's last `currency` other than the task's cap's, which is its open envelope's cap or else the business cap, or its last ceiling past the cap's remaining room; a restart draws on a new envelope, so the old one's room does not bind it, and it supersedes no version, so no hold is released) |
| `task.heartbeat`    | `/task/heartbeat`    | `operationId`, `leaseId`, `fence`, `leaseSeconds?`, `providerStarting?` (T3e1: `true` records the provider start on the lease's marked attempt, else `TRANSITION_NOT_PERMITTED` 409 with nothing written) | the lease's holder: an agent presenting the delegation minted with it, or a person on their own delegation-free lease under current `write`                                       | `DELEGATION_NOT_LIVE` 401 (agent), `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `FIELD_VALUE_INVALID` 422                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `task.check`        | `/task/check`        | `operationId`, `leaseId`, `fence`, `name`, `outcome`, `note?`                                                                                                                                             | the lease's holder, as `task.heartbeat`: the row names that holder as the actor that performed the check, and the run and version the lease works (MP-6-1)                        | `DELEGATION_NOT_LIVE` 401 (agent), `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `FIELD_VALUE_INVALID` 422 (name 1 to 120 characters, outcome `passed`, `failed` or `inconclusive`, note up to 500)                                                                                                                                                                                                                                                                                                                         |

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
  `OUTSIDE_CEILING`, `authority-controls.ts`). Each revoke reads only its own
  id: a body that also carries the other's id is `COMMAND_BODY_INVALID` 400
  naming it, before authority (`refuseOtherTarget`, `commands/prepare.ts`).
  Nothing is cached, so the next
  call on the same session re-evaluates and is refused. A read admitted before
  the revocation finishes in its own transaction. This is I10's endpoint half,
  in `tests/api/controls-revoke.test.ts` and the role-case matrix's case (f).
- **Cancellation** reaches `cancelAndClassify`. The lineage becomes
  `cancelled` with the reason as its terminal reason, the live lease is
  released, and the lineage's holds are classified. The canceller's decide on
  the task is held and checked again under the runtime locks, so a revocation
  that commits first makes the cancel `SCOPE_NOT_GRANTED` 403 with nothing
  written (`cancelAndClassify`, `core-runtime/src/recovery.ts`). The answer is
  `{ lineageId, state: 'cancelled', reservations: [{ reservationId, state, released }] }`.
  A pickup afterwards is `RESERVATION_NOT_CLAIMABLE` 409, and the refusal is
  audited. A new version in the lineage is `LINEAGE_TERMINAL`. Cancellation
  reaches a lineage on a trashed task, so a trashed task's approved hold can
  still be released. `task.restart` and `task.propose` on a trashed task
  answer `NOT_FOUND` (`lineageOnTask`, `commands/tasks-controls.ts`;
  `proposeOnTask`, `commands/tasks-propose.ts`).
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

## A person's conversation with the agent

AW-03. A conversation is minted by its first message, so opening the drawer
and closing it without sending anything writes no row. It is its owner's
alone, and its address (`/agent/<id>`) keeps answering after the body purges.

| Operation              | Route                   | Body                                                                                  | Authority                                                                                                                                                                               | Refusals                                                                                                                                                     |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation.start`   | `/conversation/start`   | `operationId`, `body`, `title?`, `subject?`, `scope?` (`{"kind":"task","id":<task>}`) | `conversation:write`; a cited task must be one the caller may read                                                                                                                      | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404 (scope), `FIELD_VALUE_INVALID` 422 (body 1 to 20000, title up to 120, subject up to 200)                            |
| `conversation.message` | `/conversation/message` | `operationId`, `conversationId`, `body`                                               | `conversation:write`, and the caller is the owner: anyone else is `SCOPE_NOT_GRANTED` whatever they hold                                                                                | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` (body purged), `FIELD_VALUE_INVALID` 422                                                |
| `conversation.read`    | `/conversation/read`    | `conversationId`                                                                      | the owner while they hold `conversation:write`; anyone else needs `conversation:read` (the read-any grant, held by nobody on install) covering the conversation's scope; a client never | `NOT_FOUND` 404 (another business, a made-up id, any client), `SCOPE_NOT_GRANTED` 403 with the reason and nothing of the conversation, `FIELD_VALUE_INVALID` |

MP-7-11 adds the assistant panel's tab row, under the same rule
(`commands/conversation-tabs.ts`, `listConversations` in `reads/conversation.ts`):

| Operation                | Route                     | Body                                                                                     | Authority                                                                                                             | Refusals                                                                                                                       |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `conversation.list`      | `/conversation/list`      | nothing                                                                                  | `conversation:write`; the caller's own conversations only, newest activity first, at most 50, whatever else they hold | `SCOPE_NOT_GRANTED` 403 (no `conversation:write`, or no membership)                                                            |
| `conversation.allowance` | `/conversation/allowance` | `conversationId?` (absent or `null`: the empty drawer)                                   | the team (owner, administrator, member) holding `conversation:write`; a named conversation is the caller's own        | `SCOPE_NOT_GRANTED` 403 (not the team, or no `conversation:write`), `NOT_FOUND` 404 (not theirs), `FIELD_VALUE_INVALID` 422    |
| `conversation.rename`    | `/conversation/rename`    | `operationId`, `conversationId`, `title`                                                 | `conversation:write`, and the caller is the owner                                                                     | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` (body purged), `FIELD_VALUE_INVALID` 422 (title 1 to 120) |
| `conversation.set_scope` | `/conversation/set_scope` | `operationId`, `conversationId`, `page` (`{"address":<path>,"shows":<label>}` or `null`) | `conversation:write`, and the caller is the owner                                                                     | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` (body purged), `FIELD_VALUE_INVALID` 422 (page)           |

`conversation.allowance` (AW-04, U10) is the drawer's allowance line:
`{ ok: true, allowance: { set, currency, limitMinor, leftMinor, conversation: { spentMinor, heldMinor } } }`,
the planning cap (`set` false is the default, AUD 50), what is left of it
across the business, and the named conversation's settled spend and held
amount (nothing, with none named). The cap and what is left are the
business's, so it is the team's only: owner, administrator and member alike
while they hold `conversation:write` across the business, a member seeing the
same cap `settings.read` shows (owner ruling, 1 October 2026). A member
without it is refused before any figure.

`conversation.set_scope` is "Add page to context" (CS-7.31): one slot, so a
second page replaces the first, and `null` clears it. The address is a page of
this product: one leading slash, never two and never a slash then a
backslash, printable ASCII with no backslash, at most 300 characters; what it
shows is 1 to 200 characters with no control character. Migration 0094
refuses the same rows as the backstop. Neither write moves the last activity,
which measures the exchange. Both answer the conversation's id and address
only, so the title and the page are stored on the conversation and nowhere
else. Each attempt writes the command's own one audit event (with the
payload's digest) and no other: this is what the ticket's "not audited" means
here, as for MP-6-2.

The answer to `conversation.read` is the conversation (id, address, title,
subject, scope, page, created, last activity, body purged at), its `messages` or
`null` once purged, the current `wrapUp` and `wrapUpHistory`, newest first.
No agent entry reaches any of them: the agent's side of an exchange is
written by the product's exchange, never by an agent calling in. The message
text is stored in `conversation_messages` and nowhere else: the answer and the
operation register carry ids and the address, and the audit event the
payload's digest.

The exchange (AW-03, `commands/conversation-exchange.ts`). Where the
deployment started a broker, `composeApi` mounts `answerConversation` beside
`executeModelCall`, and after `conversation.start` or `conversation.message`
is applied on the person path the API asks it for the agent's answer, after
the command has committed: the message stays kept whatever the answer is. It
resolves the caller again, asks that they still hold `conversation:write` (as
`conversation.read` asks of an owner), finds the message as the caller's own
person message in a conversation of this business whose body is kept, and
sends its
words through AW-01's conversation seam (`callModelInConversation`,
`model.conversation_answer`, the owner's own session, local routes only,
nothing held). The answer is kept as an `agent` message whose
`answers_message_id` names the question (0099: one reply per message, in the
same conversation), in a second transaction under the conversation's row
lock, which then holds the caller's conversation grants for share without
waiting (a revocation either is seen there or waits for the reply to commit; a
grant being changed at that moment, even by a revocation then refused, keeps
nothing, and the person asks again) and asks the grant again at
the clock after the locks, so a grant that lapsed while it waited no longer
counts. The HTTP answer then carries `reply` beside the command's own fields:
`{ answered: true, messageId, body }`, or `{ answered: false, code, words }`
in fixed words (`LOCAL_MODEL_REQUIRED`: models are off for this material and
nothing was sent, AW-03 egress off; `RATE_LIMITED`; anything else, an answer
that could not be used and nothing kept). No `reply` means nothing answers: no
broker, the grant revoked, or the message is not the caller's to have
answered. A repeat of the same operation finds the reply kept and answers with
it while the grant holds; the model is not asked again. The register stores the command's answer only, so the model's
words are in the reply's row and nowhere else.

Two system operations, the worker's and no person's command
(`commands/conversation-lifecycle.ts`), each take the conversation's row lock
first, the lock `conversation.message` takes:

- `writeWrapUp` after 24 hours quiet writes the next wrap-up version from
  records: the first message as a marked quotation, seven pointer-and-fact
  items (opened, scope, exchange, tasks created, runs started, gates raised,
  cost) and item 8, what was left open, as pointers or "nothing left open". It
  is idempotent on the conversation and its last activity.
- `purgeConversation` removes the body and keeps the conversation and every
  wrap-up. It answers `WRAP_UP_ABSENT` without a wrap-up covering the last
  activity (the database refuses the delete too), `WORK_OPEN` while cited or
  started work is open, `NOT_DUE` before the window has passed since the later
  of the last activity and the work's end, and `WINDOW_UNREADABLE` when
  `conversation_window_days` is missing, not a whole number, under seven, or
  over `retention_window_days`. A purged conversation answers `replayed`, with
  no second audit event (`conversation.purge`, actor the business's worker).

Both compare a wrap-up's `activity_through` with the conversation's
`last_activity_at` in SQL, so the covering check holds to the microsecond.
`sweepConversations` (`commands/conversation-sweep.ts`) is one pass over one
business: the wrap-up for each quiet conversation without one, then the purge
for each whose covering wrap-up existed before the pass, never both in one
pass. The purge candidates page through the wrapped bodies past the floor and
weigh each with the purge's own `WORK_OPEN` and `NOT_DUE` check (`purgeHold`): a
held one is reported and passed over, and the page limit counts only those the
purge would take. A task trashed before it ended counts as ended work at its
trash time. Each conversation is its own transaction under a lock timeout, so a
failure is that conversation's alone, reported with its body kept; an
unreadable window stops the purge for the business and the report says so.
The purge's operation identity is derived from the conversation and its last
activity, so a retried pass asks for the same purge. Nothing schedules the
pass yet, and raising a failure as an inbox item is INB-1's.

Which conversation created a task is a fact of the task's creation audit
event: `audit_events.origin_conversation_id` (0093), a same-business
reference to `conversations`, in the chain's one hash formula
(`audit_event_hash`, thirteen arguments). A null adds nothing to the hashed
text, so events without one hash as they did before 0093. The command that
creates a task from a conversation sets it; until that command exists, the
wrap-up's "tasks created" item says no task records the conversation.

## The model call

`model.call` (AW-01) is one priced model call, made by the lease holder
through the credential broker. The caller names the lease, its fence, a
catalogued operation and the prompt's fields; it never names a destination, a
credential, a price, the run's step or itself. The step is the one the lease's
attempt was reserved for, read under the lease (`stepOfLease`).

| Route                              | Body                                                                                                                                 | Authority                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `/api/a/b/:key/model/call` (agent) | `operationId`, `leaseId`, `fence`, `operation`, `fields` (each `name`, `source`, `value`, or `name` and `from`, `{ recordId, key }`) | the delegation the pickup minted, on the lease's task (`write`); then the broker's six facts, from rows, under locks |
| `/api/b/:key/model/call` (person)  | as above                                                                                                                             | refused `SCOPE_NOT_GRANTED`: the call is the run's worker's, not a person's                                          |

It runs in two parts (`commands/model-call.ts`). The agent entry runs the row
`modelCallRow` (`commands/agent-operations.ts`) through
`executeAgentOperation` (`commands/agent-envelope.ts`) unchanged: the login,
the register and its replay, the operands, the delegation and the surface row.
Its serve is the broker's reserve (`reserveModelCall`,
`core-custody/src/broker-reserve.ts`) in the same transaction, so the hold at the
operation's priced maximum, the prompt copy's registration, the register row
and the audit event commit together. A repeat of the operation id replays the
register row and sends nothing; two at once cannot both hold, because the
second waits at `enter`'s door (#932) and replays, the register's identity key
the backstop. After that commit the broker starts the call, sends it through
custody and settles it
(`sendReservedCall`), re-reading the task's client link, the lease, the
delegation and the reservation under their locks, so authority lost in between refuses the call when its
effect applies. The start sends only a call it moves from `reserved` to
`dispatched` itself: a second send of the same hold, at once or later, or a
hold the sweep released meanwhile, sends nothing (`EFFECT_NOT_RECONCILABLE`).

The answer is the call as its ledger row stands: `callId`, `state`,
`reservedMinor`, `actualMinor`, `observedMinor`, `drop`, and `text`, the
model's words, only on the request that made them. A call held as unknown
liability also answers `dropCause` (`provider_unavailable`, `connection_lost`,
`worker_lost`, or null for a failure that is no drop), `fault` (`provider`,
`network`, `ours` or `undetermined`) and `providerCode` (the provider's
refusal code, such as `http_503`, or null when none arrived); the worker hands
the run back `dropped` with that cause (AW-10, [RUNTIME.md](RUNTIME.md), "The
model call's ledger"). The words are never stored,
so a replay answers the ledger's state without them. A reserve refusal is the
register's code (`LEASE_NOT_OWNED`, `LEASE_EXPIRED`, `AUTHORITY_LOST`,
`DECISION_STALE`, `OPERATION_NOT_CATALOGUED`, `EFFECT_NOT_RECONCILABLE`,
`SOURCE_UNREADABLE`,
`LOCAL_MODEL_REQUIRED` 501, `CLIENT_MODEL_USE_OFF` (the task's client has
model use off, C60), the three `SUBSCRIPTION_` codes, `RATE_LIMITED`
with its wait, `BUDGET_UNAVAILABLE`); one recorded as a step keeps its
`model_calls` row. `BUDGET_UNAVAILABLE` is the approved ceiling reached: the
run stops and asks in the same transaction (AW-05, the budget wait in
[RUNTIME.md](RUNTIME.md)), its lease ends, and every later call on that lease
is refused as an ended lease is. `RATE_LIMITED` writes nothing and answers two ceilings,
each counting a call from its hold until it ends, and a reconciliation pass's
provider lookup while its slot lasts (AW-10, [RUNTIME.md](RUNTIME.md)): the business's own per
operation, and its fair share of the route's, which is the installation's.
The business's own is a durable limit (`hasRoom`, `core-records/src/tenancy/limit.ts`):
a count read back from the records under a lock keyed by the business, against
its maximum, held to commit. It is the one limiter: C33's occurrence rates and
run ceiling reuse it with their own counts.
A business with calls in flight on a route holds no more than the route's
ceiling divided by the businesses in flight there, itself counted. The share
is read through `model_route_room` ([DATA.md](DATA.md), "What the tenancy proofs are"),
under one lock per route. A malformed operand is `FIELD_VALUE_INVALID` by name, and
its value is never echoed into the audit.
A person's call from their own conversation takes no lease and holds no money:
local routes only, and nothing reaches it from the wire yet (the conversation
exchange that calls it is SL12's; [RUNTIME.md](RUNTIME.md), "The model call's ledger"). Where no broker is configured the
agent envelope's own `model.call` row answers `DEPENDENCY_NOT_LANDED` 501 after
the delegation check (`AGENT_OPERATIONS`).

A field is supplied, `{ name, source, value }`, or bound to the row it is
read from, `{ name, from: { recordId, key } }` (S3). A supplied field's
`source` is the caller's statement and only narrows: a claimed
`business_internal` counts as `outside`, so the field stays local. A bound
field reads what the agent may read: the run's own task, held `for share`,
and a field the task spine marks `shared`. The broker takes the value from
the row and finds the source itself: `business_internal` only when one of
the business's people entered the task through the app, the API or the
command line and no agent or worker has written to it since; otherwise
`outside`. The field reaches a cloud route only where the source is
`business_internal` and the operation also declares the field
business-internal (`effectiveClass`, `core-connectors/src/data-class.ts`;
`broker-sources.ts`). Any other row (another task, another business's, a
made-up id), a field the agent is not shown, a key the task does not hold as
text, or a task in the trash is `SOURCE_UNREADABLE` 422, recorded as a step,
in the same words whoever's row it was. The start reads the rows again, and a row that stopped being a
business-internal source since the hold releases the call unsent
(`LOCAL_MODEL_REQUIRED`); the values sent are the ones read at the start.

## The answers at the budget stop

A run stopped at its approved ceiling waits for a person (AW-05,
[RUNTIME.md](RUNTIME.md#the-answers-at-the-budget-stop)). The two answers are
commands on the person prefix, and the command line and the app's client post
them to the same routes. Both name the task, the run on it and the ask the
person was shown (`askId`, the stop's id in `task.read`'s ledger), and neither
writes the task record, so neither takes an `expectedRevision`.

| Operation                | Route                                | Body                                                                   | Authority                                                                                                                       |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `run.top_up`             | `/api/b/:key/run/top_up`             | `operationId`, `recordId`, `runId`, `askId`, `amountMinor`, `currency` | `decide` on `billing`, asked of the task named in `recordId`; the runtime asks it again of the run's task under the run's locks |
| `run.end_at_budget_stop` | `/api/b/:key/run/end_at_budget_stop` | `operationId`, `recordId`, `runId`, `askId`                            | `decide` on `gate`, asked the same way                                                                                          |

## The hand-over and the handback

AW-11. The holder of a lease hands part of its work to a helper agent that can
do strictly less (`run.delegate_child`), and the helper hands its result back
(`run.child_handback`). Both are served on the agent prefix only
(`commands/agent-child.ts`); the person prefix refuses both
`SCOPE_NOT_GRANTED`.

| Route                                      | Body                                                                                                                                 | Authority                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `/api/a/b/:key/run/delegate_child` (agent) | `operationId`, `leaseId`, `fence`, `helperActorId`, `purpose`, `collections`, `actions`, `expiresInSeconds` (1 to the lease maximum) | the caller's own delegation, on the lease's task (`run:write`); the runtime binds it to the lease at its fence under locks |
| `/api/a/b/:key/run/child_handback` (agent) | `operationId`, `outcome` (`completed`, or `partial` with `refusal`, a registered code)                                               | the helper's own child credential, bound to its login; no grant, so a revoked or run-out child still hands back            |

The body is read by its JSON types before any authority, each fault
`FIELD_VALUE_INVALID` by name (a purpose and each collection is a short key;
actions are the grant model's; `decide` is refused by the mint,
`DELEGATION_EXCLUDES_DECISION`), and a field the row does not describe is
`COMMAND_BODY_INVALID`. A helper that is not an agent of this business is
`FIELD_VALUE_INVALID` on `helperActorId`, one answer for a person's id and a
made-up one. A set that is not strictly narrower is `DELEGATION_WIDENS`.

The hand-over answers the helper's one-call pickup (AUTHORITY.md,
"Sub-delegation"), its `credential` in the clear on this answer only. The
register keeps the answer without it; a repeat of the operation id
re-authorises the parent, finds the child still live and its own, and derives
the credential again under its pinned key. A child handed back, withdrawn or
run out releases nothing (`DELEGATION_NOT_LIVE`). The handback answers
`childDelegationId` and `outcome`; its replay is released only to the same
helper presenting the same credential. A second handback is
`DELEGATION_NOT_LIVE`.

## The plan accept

A person's one click on a plan (AW-04, [RUNTIME.md](RUNTIME.md#instruction-files-pinned-by-digest))
is `task.accept_plan`: the approval of the plan's gate, as `task.decide`
approves one, with the plan bound to the decision and the run's instruction
file pinned in the same transaction. The command line and the app's client
post it to the same route. No agent reaches it: an agent may propose a plan,
never activate one.

| Operation          | Route                          | Body                                                                                                                                                          | Authority                                                                                          |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `task.accept_plan` | `/api/b/:key/task/accept_plan` | `operationId`, `gateId`, `versionId`, `note`, `planText`, `plan`, `entryPath`, `paths`, `ceilingMinor` and `currency` (optional), `conversationId` (optional) | `decide`, asked of the gate's own task as `task.decide` is; `decide` asks it again under its locks |

`versionId` is the plan version shown beside the button; a newer reply makes
it stale and the accept is `PROPOSAL_SUPERSEDED` 409. `planText` is the exact
words the person read (1 to 20,000 characters). `plan` is the structured
record `{ steps: [{ key, title, after }] }`: a lower-case slug per key, each
`after` naming earlier keys of this plan, no other fields, no duplicate keys or
references, no cycle; anything else is `FIELD_VALUE_INVALID` 422 naming `plan`
(or `planText`), before any write. `entryPath` and `paths` (up to 50) name
files in the server's instruction root (`OPS_ASTRO_INSTRUCTION_ROOT`); an odd
path, a symlink, a name outside the root, a directory or a missing file is
`DEFINITION_UNAVAILABLE`. With no root configured the accept is
`DEPENDENCY_NOT_LANDED`. `ceilingMinor` and `currency` are the rough cost the
card drew, sent together or not at all (half of one, or a fraction of a minor
unit, is `FIELD_VALUE_INVALID` 422); under the locks, a ceiling other than the
version's maximum and currency is `VERSION_STALE` 409 and nothing is approved
or held. Callers that draw no ceiling send neither. `conversationId` is the caller's own conversation
or `NOT_FOUND` 404, and becomes the audit event's origin. Every other refusal
is `task.decide`'s. It answers the approval's detail with `runId`, `pin`,
`manifestDigest`, `planRecordId`, `textDigest` and `recordDigest`. A repeat of
the operation id replays it; a changed body is `OPERATION_ID_REUSED`.

**The plan accept fires nothing (AW-08).** It lets the agent work under its
lease; it never releases an effect. The agent hands its output back with a
successor (`task.handback`'s `successor`), and that version is the reviewed
output. Its accept, by `task.decide` or `task.accept_plan`, is the launch, and
only a lease on a reviewed output may `task.dispatch`. Any other approved
version is `LAUNCH_NOT_DECIDED` 409 before any mark, and nothing is written.
The worker (`apps/worker`) answers that refusal by handing the work back as
its successor (outcome `handedBack`, with the successor's gate and version);
the next pass after a person's accept picks up the launch and applies it.

A run's state revised (MP-6-2) is the agent page's one write. It names the
task and the run on it too, and carries the version it read (0 before the
first) instead of an `expectedRevision`. It is also on the agent prefix, under
a delegation minted with `run` (the agent is the recorded actor).

| Operation          | Route                          | Body                                                                           | Authority                                                                                              |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `run.revise_state` | `/api/b/:key/run/revise_state` | `operationId`, `recordId`, `runId`, `expectedVersion`, `knowledge`, `unknowns` | `write` on `run`, asked of the task named in `recordId`; an agent's, of its delegation on its own task |

It answers `detail: { runId, version }`. `knowledge` and `unknowns` are lists of
up to 50 non-empty texts of at most 2,000 characters; anything else is
`COMMAND_BODY_INVALID` naming the field. A version other than the newest is
`VERSION_STALE`, and a run not on the named task answers as a made-up one
(`reviseStateOnRun`, `commands/run-state.ts`).

The handlers are `topUpOnRun` and `endOnRun` (`commands/run-answers.ts`), over
`topUpAtBudgetStop` and `endAtBudgetStop` (`core-runtime/src/budget-answer.ts`).

- **The top-up** answers `detail: { runId, state: 'applied', answerId,
heldMinor }`, and the run is back in the queue for a fresh pickup. Above the
  business's four-eyes threshold the first person's answer is
  `detail: { runId, state: 'awaiting_second', approvalId, thresholdMinor }`
  and applies nothing; a second, distinct holder sending the same amount
  completes it. `amountMinor` is a whole number of the currency's minor units
  above zero and `currency` the envelope's three-letter code.
- **The end** answers `detail: { runId, state: 'cancelled', answerId,
releasedMinor, spentMinor }`. The task stays open for a person. It reaches a
  task in the trash, as `task.cancel` does; a top-up does not.
- **Refusals.** A task not in this business, a run that is not on the named
  task, and a made-up run are all `NOT_FOUND` 404, the last two with the same
  bytes. `SCOPE_NOT_GRANTED` 403 for a caller without the grant on that task.
  From the runtime: `FOUR_EYES_REQUIRED` 409 naming the threshold (the same
  person twice), `SCOPE_NOT_GRANTED` naming the plan approver while they still
  hold `billing:decide`, `FIELD_VALUE_INVALID` 422 (the amount, the currency,
  or a second approval of a different amount), `CAP_BINDING_MISMATCH`,
  `BUDGET_EXHAUSTED` (the business cap is the hard ceiling), `LINEAGE_TERMINAL`
  and `TRANSITION_NOT_PERMITTED` 409 (the run is not waiting, the ask is
  already answered, or `askId` is not the ask the run waits on: an answer to
  an earlier stop never applies to a later one). A refusal writes nothing.
- **No agent answers.** Neither row is in `AGENT_SURFACE`: the agent prefix
  answers `DELEGATION_EXCLUDES_OPERATION` 403 with or without a delegation.
- **Recent sign-in.** `run.top_up` holds `billing:decide`, so C59's step-up
  asks it in the envelope: `STEP_UP_REQUIRED` 403 past 60 minutes while the
  business's money step-up setting is on (`C54 recent sign-in`). The end holds
  `gate:decide`, which the step-up does not ask.
- **Not here yet.** The question and its two buttons in the conversation where
  the plan was approved (AW-04).

## The launch and its receipt

AW-08 part (b) ([RUNTIME.md](RUNTIME.md#the-launch-is-the-effect-gate)). The
launch is the accept of the reviewed output's exact version; accepting the
plan never releases an effect.

- **`task.dispatch`** (the lease's holder, agent prefix) rechecks the facts
  under its locks and refuses, writing and marking nothing: `AUTHORITY_LOST`
  409, `PROPOSAL_SUPERSEDED` 409, `LINEAGE_TERMINAL` 409, `DECISION_STALE` 409
  (a reset approval), `LAUNCH_NOT_DECIDED` 409 (work approved by the plan
  accept rather than a launch), `CLIENT_SIGNOFF_REQUIRED` 409 (the business
  requires the client's sign-off, which the portal records in phase 8; until
  then the work stays held), then the lease's and the budget's codes as
  before.
- **`task.observe`** takes an optional `receiptLink`: the link the provider
  answered with, as the worker passed it on. It is kept only when it is
  `https:` on the step's declared host, with no user, port, query or
  fragment, at most 512 characters and already in its parsed form; any other
  value, a non-string included, is stored as absent and the observation goes
  on. It is written with the first observation and never after.
- **`task.receipt`** adds `link`: the kept link, or `null` when none was kept,
  which a reader shows as text and never as a link. Nothing on the receipt
  undoes the effect.

## Source-to-route manifest

Every route is generated from `COMMAND_SURFACE`
(`packages/core-wire/src/surface.ts`, 29 writes and 7 reads) by
`mountSurface` in `createApi` (`apps/api/app.ts`), once for the person prefix
and once for the agent prefix, with the path from `pathOf` in the same file.
The command line builds its verbs from the same table (`VERBS`,
`apps/cli/client.ts`) and posts them to the person prefix, or to the agent
prefix when a call asks for it. Both mounts are `PREFIX` in
`core-wire/src/surface.ts` (`/api/b/` and `/api/a/b/`), and the delegation header's
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

| Operation                | Person route                            | Agent route                             | Handler                                                                                                                                                                               | Owning function                                                                                             |
| ------------------------ | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `grant.revoke`           | `/api/b/:key/grant/revoke`              | refused `DELEGATION_EXCLUDES_OPERATION` | `revokeGrantAsManager` (`commands/authority-controls.ts`)                                                                                                                             | `revokeGrant` (`authority/grants.ts`)                                                                       |
| `delegation.revoke`      | `/api/b/:key/delegation/revoke`         | refused `DELEGATION_EXCLUDES_OPERATION` | `revokeDelegationAsManager` (`commands/authority-controls.ts`)                                                                                                                        | `revokeDelegation` (`authority/delegations.ts`)                                                             |
| `task.cancel`            | `/api/b/:key/task/cancel`               | refused `DELEGATION_EXCLUDES_OPERATION` | `cancelOnTask` (`commands/tasks-controls.ts`)                                                                                                                                         | `cancelAndClassify` (`core-runtime/src/recovery.ts`)                                                        |
| `task.restart`           | `/api/b/:key/task/restart`              | refused `DELEGATION_EXCLUDES_OPERATION` | `restartOnTask` (`commands/tasks-controls.ts`)                                                                                                                                        | `restart` (`core-runtime/src/restart.ts`) → `propose`, with `refuseRestart` (`core-runtime/src/propose.ts`) |
| `task.heartbeat`         | `/api/b/:key/task/heartbeat`, own lease | `/api/a/b/:key/task/heartbeat`          | person: `heartbeatOwnLease` (`commands/tasks-lease.ts`); agent: the row's `serve` (`AGENT_OPERATIONS`, `commands/agent-operations.ts`) → `heartbeatLease` (`commands/tasks-lease.ts`) | `heartbeat` (`core-runtime/src/heartbeat.ts`)                                                               |
| `task.check`             | `/api/b/:key/task/check`, own lease     | `/api/a/b/:key/task/check`              | person: `checkOwnLease` (`commands/tasks-check.ts`); agent: the row's `serve` (`AGENT_OPERATIONS`) → `checkLease` (same file)                                                         | `recordCheck` (`core-runtime/src/checks.ts`)                                                                |
| `conversation.start`     | `/api/b/:key/conversation/start`        | refused `DELEGATION_EXCLUDES_OPERATION` | `startConversation` (`commands/conversations.ts`)                                                                                                                                     | `conversations`, `conversation_messages`                                                                    |
| `conversation.message`   | `/api/b/:key/conversation/message`      | refused `DELEGATION_EXCLUDES_OPERATION` | `messageConversation` (`commands/conversations.ts`)                                                                                                                                   | `conversation_messages`                                                                                     |
| `conversation.read`      | `/api/b/:key/conversation/read`         | refused `DELEGATION_EXCLUDES_OPERATION` | `readConversation` (`reads/conversation.ts`)                                                                                                                                          | `conversations`, `conversation_messages`, `conversation_wrap_ups`                                           |
| `conversation.list`      | `/api/b/:key/conversation/list`         | refused `DELEGATION_EXCLUDES_OPERATION` | `listConversations` (`reads/conversation.ts`)                                                                                                                                         |
| `conversation.allowance` | `/api/b/:key/conversation/allowance`    | refused `DELEGATION_EXCLUDES_OPERATION` | `readAllowance` (`reads/allowance.ts`) → `readPlanningAllowance` (`core-custody/src/broker-planning.ts`)                                                                              |
| `conversation.rename`    | `/api/b/:key/conversation/rename`       | refused `DELEGATION_EXCLUDES_OPERATION` | `renameConversation` (`commands/conversation-tabs.ts`)                                                                                                                                |
| `conversation.set_scope` | `/api/b/:key/conversation/set_scope`    | refused `DELEGATION_EXCLUDES_OPERATION` | `setConversationScope` (`commands/conversation-tabs.ts`)                                                                                                                              |

The others. `runAgentCommand` (`commands/agent-envelope.ts`) refuses a
name outside `AGENT_SURFACE` before it reads anything else. Each name the agent
is served is a row of `AGENT_OPERATIONS` (`commands/agent-operations.ts`), and
its `serve` holds the case. `AGENT_SURFACE` and `BEFORE_PICKUP` are read off
the surface rows' own `agent` field (`COMMAND_SURFACE`), so the surface table
says what an agent reaches and `AGENT_OPERATIONS` says how each is served.
`tests/commands/agent-surface-derivation.test.ts` holds the two to one list.

| Operation                                  | Person prefix: owning function                                                            | Agent prefix                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.create`                              | `createTask` (`commands/tasks-write.ts`)                                                  | an agent credential's (API-2); under a pickup refused `DELEGATION_OUT_OF_PURPOSE`                                                                                                      |
| `task.update`                              | `updateTask` (`commands/tasks-write.ts`)                                                  | served under a live delegation, on its own task, `description`, `agent_brief`, `title`, `due`, `estimated_minutes` and `page_link` only (MP-4-7, MP-4-8, MP-4-12; `updateTaskAsAgent`) |
| `task.complete`                            | `setState` (`commands/tasks-state.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.reopen`                              | `setState` (`commands/tasks-state.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.comment`                             | `commentOnTask` (`commands/tasks-comment.ts`)                                             | served under a live delegation, `internal` audience only (the row's `serve`, `AGENT_AUDIENCES`)                                                                                        |
| `task.edit_comment`, `task.delete_comment` | `editTaskComment`, `deleteTaskComment` (`commands/tasks-comment-edit.ts`)                 | served under a live delegation, on its own task, on its own actor's comments only (`serveCommentChange`)                                                                               |
| `task.propose`                             | `proposeOnTask` (`commands/tasks-propose.ts`)                                             | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.decide`                              | `decideOnGate` (`commands/tasks-decide.ts`)                                               | refused `DELEGATION_EXCLUDES_DECISION` (`authorise`, `decideAsAgent`)                                                                                                                  |
| `task.accept_plan`                         | `acceptPlanOnGate` (`commands/plan-accept.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.pickup`                              | `pickupAsPerson` (`commands/tasks-pickup.ts`)                                             | served before a pickup (`BEFORE_PICKUP`, `serve`)                                                                                                                                      |
| `task.handback`                            | `handbackOwnLease` (`commands/tasks-handback.ts`)                                         | served under a live delegation (`serve`)                                                                                                                                               |
| `task.start`                               | `setState` (`commands/tasks-state.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.set_state`                           | `setStateById` (`commands/tasks-state.ts`)                                                | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.duplicate`                           | `duplicateTask` (`commands/tasks-duplicate.ts`)                                           | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.assign`                              | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | served under a live delegation holding `assign`, on its own task, `assignee` only (MP-4-8; `assignTaskAsAgent`)                                                                        |
| `task.triage`                              | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_INTAKE` (`runAgentCommand`)                                                                                                                               |
| `task.set_stage`                           | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.set_party`                           | `setParty` (`commands/tasks-party.ts`), then `writeOwnedFields`                           | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.set_audience`                        | `writeOwnedFields` (`commands/tasks-state.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.set_scores`                          | `setScores` (`commands/tasks-scores.ts`)                                                  | served under a live delegation, on its own task (`serve`)                                                                                                                              |
| `task.set_adhoc`                           | `setAdHoc` (`commands/tasks-adhoc.ts`)                                                    | served under a live delegation, on its own task (`serve`)                                                                                                                              |
| `task.set_category`                        | `setCategory` (`commands/tasks-category.ts`)                                              | served under a live delegation, on its own task (`serve`)                                                                                                                              |
| `task.share_with_client`                   | `shareWithClient` (`commands/tasks-client-access.ts`)                                     | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.revoke_client_share`                 | `revokeClientShare` (`commands/tasks-client-access.ts`)                                   | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.reparent`                            | `reparentTask` (`commands/tasks-place.ts`)                                                | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.move`                                | `moveTask` (`commands/tasks-place.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.rank`                                | `rankTask` (`commands/tasks-place.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.trash`                               | `trashTask` (`commands/tasks-trash.ts`)                                                   | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.restore`                             | `restoreTasks` (`commands/tasks-trash.ts`)                                                | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.purge`                               | `purgeTasks`, window read by `retentionWindowDays` (`commands/tasks-trash.ts`)            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.read`                                | `readTaskDetail`, or `readSharedTask` for a reader who is not internal (`reads/tasks.ts`) | served under a live delegation (`serve`)                                                                                                                                               |
| `task.board`                               | `readBoard` (`reads/tasks.ts`)                                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.queue`                               | `readQueue` (`reads/queue.ts`)                                                            | served before a pickup (`BEFORE_PICKUP`, `serve`)                                                                                                                                      |
| `person.list`                              | `listPeople` (`reads/people.ts`)                                                          | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `preset.plan`                              | `planPresetSync` (`records/preset-plan.ts`)                                               | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `settings.read`                            | `readSettings` (`reads/settings.ts`)                                                      | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `session.capabilities`                     | `readCapabilities` (`reads/capabilities.ts`)                                              | served under a live delegation (`authorise`, `capabilitiesOf`)                                                                                                                         |
| `settings.set_four_eyes_threshold`         | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `settings.set_client_sign_off`             | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `secret.list`                              | `listCustodySecrets` (`reads/custody.ts`)                                                 | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `secret.set`                               | `setCustodySecret` (`commands/custody-secrets.ts`)                                        | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `secret.clear`                             | `clearCustodySecret` (`commands/custody-secrets.ts`)                                      | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `time.start`                               | `startTime` (`commands/tasks-time.ts`)                                                    | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `time.stop`                                | `stopTime` (`commands/tasks-time.ts`)                                                     | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `time.log`                                 | `logTimeEntry` (`commands/tasks-time.ts`)                                                 | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `time.set_note`                            | `setEntryNote` (`commands/tasks-time.ts`)                                                 | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `time.delete`                              | `deleteEntry` (`commands/tasks-time.ts`)                                                  | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `tag.create`                               | `createTagNamed` (`commands/tasks-tags.ts`)                                               | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.add_tag`                             | `addTagToTask` (`commands/tasks-tags.ts`)                                                 | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.remove_tag`                          | `removeTagFromTask` (`commands/tasks-tags.ts`)                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `tag.list`                                 | `listTags` (`core-records/src/tasks/tags.ts`)                                             | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.todos`                               | `readTodos` (`reads/todos.ts`)                                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| ----------------------------------         | ----------------------------------------------------------------------------------------- | -----------------------------------------------------------------------------------------------                                                                                        |
| `task.ledger`                              | `readLedger` (`reads/ledger.ts`)                                                          | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `task.search`                              | `searchTasks` (`reads/search.ts`)                                                         | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `team.list`                                | `listTeam` (`reads/people.ts`)                                                            | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `session.person`                           | `readOwnName` (`reads/people.ts`)                                                         | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `session.end`                              | `endOwnSession` (`commands/session-end.ts`)                                               | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `settings.set_money_step_up`               | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `settings.set_conversation_window`         | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |
| `settings.set_retention_window`            | `setBusinessSetting` (`commands/settings-write.ts`)                                       | refused `DELEGATION_EXCLUDES_OPERATION`                                                                                                                                                |

| `automation.registry` | `readAutomationRegistry` (`reads/automations.ts`) | refused `DELEGATION_EXCLUDES_OPERATION` |
| `activation.change` | `changeActivationAsPerson` (`commands/automations.ts`) | refused `DELEGATION_EXCLUDES_OPERATION` |
| `definition.release` | `releaseDefinitionVersion` (`commands/automations.ts`) | refused `DELEGATION_EXCLUDES_OPERATION` |
"Served under a live delegation" means an agent call with no credential is
refused `DELEGATION_EXCLUDES_OPERATION` (see "The agent's own entry point").

## The cap's currency

`task.read` carries `capCurrency`: the currency of the cap an approval on the
task would draw on, which is the open envelope's cap, or the business's cap
before the task has an envelope. `task.propose` refuses a proposal in another
currency with `PROPOSAL_SCOPE_EXCEEDED` and `task.decide` a version in another
with `CAP_BINDING_MISMATCH`, so a client offers this currency and no list of
its own. It is `null` when the business has no cap. It is read inside the task
read, so a caller refused the task is told nothing about the cap
(`tests/api/cq-7.test.ts`).

## The derived rank

`task.read` carries `rank`: `number` (the task's #N), `score` and `calc`, the
line drawn under it (R70, MP-4-9). It is worked out at read and never stored.
The score is impact × confidence × ease × priority weight × age boost, rounded
half up in exact integers; a task missing a mark has `number` and `score` null
and a `calc` naming the missing marks. `number` is the task's place among the
open tasks the reader's read grants reach (`readableRecordIds`, inside the
query), so a task the reader cannot see never moves it; on the agent prefix the
pool is the agent's one delegated task. A reader outside the business gets the
shared view, which has no rank. No business names priority stages and no task
has a start date yet, so every task takes a weight of 1 and no age boost, and
the line prints both as 1 (`reads/rank.ts`, `tests/reads/task-rank.test.ts`).

## The Ad hoc mark

`task.read` carries `adHoc`: true when the task is marked ad hoc through
`task.set_adhoc` (MP-4-10, CS-4.9), false when it is not or was never marked.
Billing reads it, and a new time entry on the task takes the same mark in
its own insert (`core-records/src/tasks/time.ts`), the value
`adHocDefault` (`reads/tasks.ts`) reads, so the timer and the page cannot
disagree. The shared view carries no `adHoc`.

## Time tracking

`task.read` carries `time` (MP-4-6): the reader's own live entries on the
task, newest first, their running timer on it or null, and `totalMinutes`,
every person's finished minutes on the task as one number. Another person's
entries are never sent (RS-VAULT-9: a person sees their own time, never a
leaderboard); the total is what the burn bar reads. An agent is sent
`time: null`, and the shared view carries none.

The five `time.*` commands take `time:write`, asked of the business, and
`time.start`, `time.stop` and `time.log` then ask `task:read` on the task
they name, so a person times only a task they may read. None names a
revision: an entry is a row beside the task. The entry is always the
caller's own. A person has one running timer (a partial unique index, so
two starts at once leave one). `time.stop` stops only the caller's timer on
the task it names: it is the one stop-and-log step every closing surface
calls (R77), and it logs the elapsed minutes rounded up, never fewer than
one. A running entry is stopped before it can be deleted. Each is audited
under its own name (`time entry started`, `time entry created`,
`time entry note changed`, `time entry deleted`), with no subject record
and `recordId: null` in the answer, so no time event is in a task's
`history` or in `task.ledger`: those name who acted and when, which would
be another person's time. No agent reaches them yet, although the key
catalogue allows `time:write` inside a delegation.

## The description and the agent brief

`task.read` carries `description` and `agentBrief` (MP-4-7, CS-4.23, CS-4.24),
each null when none is written. Both are task text written through
`task.update` under `task:write`; `agent_brief` is a field of its own
(migration 0076), unslotted and internal like the description, so the shared
view carries neither. The audit row names `task.update`; the field changed is
the result's `changed` list, which the register stores in the same
transaction. An agent writes the two on its own delegated task through
`task.update` (`updateTaskAsAgent`), and with them the name, the due date,
the estimate and the page link, which MP-4-8's and MP-4-12's Permissions tables give it
"inside its delegation"; each is still held to the delegation's `task:write`
and to the task's own field rules. Any other field in the body is refused
`SCOPE_NOT_GRANTED`, naming it, and nothing is written. Its `task.assign`
(`assignTaskAsAgent`) sets only the assignee of its own task, and only under a
delegation holding `assign`: a pickup's delegation carries read, comment and
write, so that one is refused `DELEGATION_OUT_OF_PURPOSE`, and the delegate is
refused `SCOPE_NOT_GRANTED` by name.

`task.read` also carries `pageLink` (MP-4-12, CS-4.22): the in-product address
the task is about, its path and hash, or null. It is `page_link` (migration
0079), unslotted and internal, written through `task.update` under
`task:write` and audited as that command. `task.create` and `task.update`
keep only an address inside the product (`isInProductLink`, core-wire): one
`/` first, no `//` or `/\` host, no backslash, whitespace or control
character, at most 2,048 characters. Anything else is refused
`FIELD_VALUE_INVALID`, naming `page_link`, and nothing is written. The web
applies the same rule before drawing a stored link as a door.

`task.read` also carries `estimateMinutes` (MP-4-8, CS-4.14): the time the
burn bar and time logged measure against, in whole minutes, or null when not
set. It is `estimated_minutes` (migration 0080), numeric, unslotted, generic
and internal, as the fixed-slots contract classifies it, written through
`task.update` under `task:write` and audited as that command; an agent writes
it on its own delegated task. `task.create` and `task.update` keep only whole
minutes from 0 to 1,000,000: another number is refused `FIELD_VALUE_INVALID`
naming `estimated_minutes`, another kind naming `estimated_minutes=numeric`,
and nothing is written.

`task.read` also carries `category` (MP-4-8, CS-4.16, DP-23): the task's work
label as the id of one of the nine `TASK_CATEGORIES`
(`core-wire/task-categories.ts`), or null for none. It is `category` (migration 0084), text, unslotted, internal,
owned by `task.set_category` under `task:write` and audited as that command
(the tracked action `task.category changed`); an agent sets it on its own
delegated task. Any value but a catalogue id or null is refused
`FIELD_VALUE_INVALID` naming `category` and nothing is written. A category is
a label only (R76): the command writes the one field and reaches no grant,
delegation or scope (`MP-4-8 category leaves agent scope`). The shared view
carries no `category`.

## The conversation

`task.read`'s comments each carry `parent` and `signal` (MP-4-5, R42,
DT-19). A reply names the top-level message it sits under, one level deep,
on the same task and in that message's audience (`task.comment` with
`parentId`), so a client is only ever shown the id of a client message. A
top-level client message's `signal` is `owed` when one of the client's
people wrote it and nobody on the team has replied to it, `not_acknowledged`
when the team wrote it and none of the client's people has replied, and
`answered` once the other side replies; a general message on the Client tab
answers nothing. Seen waits on a client read receipt, which the portal
records. Internal notes and replies carry `null`. Authors rewrite and delete
their own messages and replies through `task.edit_comment` and
`task.delete_comment`; a deleted comment leaves every read and its replies
stay. An internal reader's comments also carry `own`, true where the
reader's own actor wrote it, so the page draws the edit and delete controls
on those rows only; the two commands check the author again. An @ in a comment notifies nobody yet: there is no notification model.

For the agent bundles, `readConversation` (`reads/task-conversation.ts`) reads a
task's thread at three detail levels in one statement each: `brief` (the
counts and the last message), `standard` (the counts and the last twenty)
and `full` (the whole thread). A reader outside the business gets the client
messages alone, no internal count, and each message in the fields the
catalogue marks `shared`.

## Client access

`task.read` carries `clientAccess` (MP-4-10, CS-4.10, R45): true exactly when
someone outside the business's membership holds a live read share on the
task (`outsideHolders`, `reads/tasks.ts`). Nothing is stored beside the
grants. `task.share_with_client` shares the task, for reading, with the
client's existing people: each person outside the membership standing on
the task's client through a live party-scoped `task:read` grant. It enrols
and invites no one, and a client nobody stands on is refused rather than
shared with nobody. `task.revoke_client_share` withdraws every live read
share held outside the membership, so a task whose client changed after it
was shared is not left visible to the old client's people. Both take
`access:share`, which an agent never holds, and each is audited under its
own name (`share grant created`, `share grant revoked`). The shared view
carries no `clientAccess`.

## The board on a task

`task.read` carries `board` (MP-4-1, CS-4.38), the board the task sits on as
its page's crumb reads it: null when it sits on none, `{ readable: true, id,
title }` when the reader may read that board, and `{ readable: false }`
otherwise (`reads/board-crumb.ts`). The id goes only where the title goes;
the dock panel's Project select marks the task's board by it (MP-4-8). A board is a task, so the check is the
single-record `task:read` check `task.read` makes, asked of the id in the
`board` slot before the board row is read; a reader refused it is told only
that there is a board. The title is read from the board's own row at every
read, filtered by the business, so a slot naming another business's record
reads as no board. An agent's pool is its one task, so an agent always gets
`{ readable: false }`. The shared view carries no `board`.

`task.read` also carries `stage`, the stage as `task.set_stage` stored it
(null for none), and `clientSet`, true when the task is put under a client
(`task.set_party`), for the task page's facts band (MP-4-2). Both are the
task's own record; the shared view carries neither.

A member's `task.read` also carries `client`, the client the task is under by
id (null for none, and null for a client the reader's grants do not reach:
`client.list`'s rule, a grant across the business or one on that client, so a
reader held to client B and shared one of client A's tasks reads `client: null`
beside `clientSet: true`, CS-4.12), and `hasContent`, true once the task has
content, the answer S0-5's lock gives `task.set_party` (`CLIENT_LOCKED`), for the dock
panel's Client field (MP-4-8). Both are read in `commands/task-content.ts`,
the lock's own module, so the field and the lock agree. The client's name is
never sent here: it is `client.list`'s, filtered by the reader's grants. An
agent's detail and the shared view carry neither.

`task.read` carries `steps`, the task's subtasks (MP-4-4): each is a full
task whose `parent` is this one, read with the parent in one query
(`readTaskFamily`) in the order they were added, and each is sent only when
the reader's own grants reach it, so a record-scoped reader of the parent is
not told a step they may not read exists. A step carries its `id`, `key`,
`title`, `state`, `done` (the completed category), `archived` (when and why it
left the count without being done, or null), `awaitingApproval` (a gate on
its live version is pending and not expired, asked only of the steps sent,
`awaitingApproval` in `reads/awaiting.ts`), `assignee` and `revision`. An
agent reads under its one task and is sent no steps. The shared view carries
none.

Completing a task marks each unfinished live subtask archived (MP-4-15):
`task.complete` writes `archived_at` and `archived_why` ("The parent task
was completed.") on every direct subtask not completed, cancelled or already
archived, and leaves each one's state as it was; `task.reopen` removes the
mark from exactly the subtasks that completion archived. Both run in the
transition's own transaction, after the subtasks are locked and the caller is
asked `task:write` on each (a business-wide writer once): the first out of
reach refuses the whole transition, and nothing is written. An archived step
is out of the Team count and takes no rank number.

A subtask carries its parent's client. `task.create` with a `parentId` copies
the parent's client onto the new task; `task.set_party` on a subtask naming any
other client, and `task.reparent` under a parent whose client differs from the
task's own, are refused `PLACEMENT_IS_DERIVED` naming `client`; a client set
on a task carries down its live subtree in the same transaction, each
descendant asked `task:share` at its own scope first.

## Proposal projection

`task.read` carries every proposal on the task under `proposals`, newest
lineage first. It is on the detail rather than behind a read of its own because
a page that showed the evidence and then fetched the version separately could
offer a decision on a version it never displayed, and the exact version is the
whole of what `decide` compares.

Each version carries `checks`: the checks its run recorded through
`task.check` under the run's lease, oldest first, each with its `outcome` and
the lease holder as `performedByActorId` (MP-6-1, CS-16.3; `run_checks`,
migration 0091). They are read in the same snapshot as the rest.

Each lineage carries `scopes`: what each lease its runs took was allowed to
touch, oldest first (MP-6-4, CS-6.1). A scope is the lease's own delegation,
the one the broker set at pickup (R71), so nothing a person edits on the task
reaches it (R76): its `purpose`, the one resource it was minted for (`scope`),
its `collections` and `actions`, `grantedAt`, `expiresAt`, a `state` of
`live`, `expired`, `revoked` or `settled`, the `delegatePersonId` whose grants
are its ceiling, and `grants`, the live grants of that person it draws on now:
business-wide ones and ones on this task's record, never a grant on another
record. A lease a person holds has `delegation: null`. It is read in the same
snapshot as the rest (`reads/run-scopes.ts`).

`gate.pending` is the one awaiting-review read (MP-6-1, TR-P-14): every gate
still waiting on a person, on a live lineage's current version, on a task not
in the trash, before its deadline on the database's clock. It is filtered by
the caller's `decide` on tasks (`gate:decide`) inside the statement that reads
the gates (`coveredScopes`, `authority/grants.ts`), so a record-scoped decider
sees only its own records' gates, and a caller holding no `decide` anywhere is
refused `SCOPE_NOT_GRANTED` 403 rather than answered with an empty list
(`reads/awaiting-review.ts`; `tests/api/mp-6-1-isolation.test.ts`).

`definition.attribution` (AW-04) is attribution across runs, by an
instruction file's digest (`{ digest }`, 64 lowercase hex, else
`FIELD_VALUE_INVALID` naming `digest`): the runs whose read ledger holds the
file, entry and non-entry reads alike, each with its task, the paths it read
the file at, whether it was the entry, and the operations its model calls
reached (a refused call reached nothing), and the union of those operations.
It is pre-review: the answer and every run in it carry `label: 'pre-review'`;
it may floor a declaration of reach and nothing else, and no evaluation set,
promotion input or conformance claim takes it (the deps cruise rule
`pre-review-attribution-stays-in-its-read` holds the module to its catalogue
row). It is the team's: a reader outside the team, or one holding no `read` on
tasks, is refused `SCOPE_NOT_GRANTED` 403; each run is filtered by the
caller's task `read` inside the statement, as `gate.pending` filters by
`decide`, and a trashed task's runs are not listed. No agent route
(`reads/attribution.ts`; `tests/runtime/aw-04-attribution.test.ts`).

`trace.read` (AW-13 readers) is a task's runs' diagnostic trace (`{ recordId }`):
each run event as the export sends it, less the two ids only the exporter's
key derives (stage, sequence, start and duration in whole milliseconds, a
bounded error code, the transform version), with its run and whether it is
behind the export's cursor; at most 1,000, `complete` saying whether that
reached the end. It asks `operations:read` (the owner and administrators by
install default, never a member, never an agent) at the task's record scope;
a holder without `read` on the task, a task of another business and a trashed
one are `NOT_FOUND`, and a member without the key `SCOPE_NOT_GRANTED`. No agent
route (`tests/runtime/aw-13-readers.test.ts`; [RUNTIME.md](RUNTIME.md#the-diagnostic-trace-export)).

`harness.read` (AW-12) is the harness adoption test's result on one run
(`{ runId }`, a string, else `FIELD_VALUE_INVALID` naming `runId`), as
`{ ok: true, harness }`. `harness` is the trigger's reading: `result: 'not_yet'`
with the `missing` limbs and the two `figures` (the reading against the window,
the delegation depth against the depth built), or `result: 'fired'` with the
same two figures and no verdict. The per-candidate runs, with a verdict and a
recommendation per framework, are AW-12's follow-up, built when the trigger
first fires; this read does not carry them yet. It is computed from the run's
frozen accept-time manifest on every read and stores nothing. It is the
team's: a reader outside the team, or one holding no `read` on tasks, is
refused `SCOPE_NOT_GRANTED` 403; the run is
filtered by the caller's task `read` inside the statement, so another client's
run, another business's and a made-up one are one `NOT_FOUND` 404. A manifest
it cannot count is `DEFINITION_UNAVAILABLE`. No agent route; the command line
is `pnpm cli harness.read --json '{"runId":"..."}'`
(`reads/harness-trigger.ts`; `tests/harness/aw-12-harness-read.test.ts`;
[RUNTIME.md](RUNTIME.md#the-harness-adoption-tests-trigger)).

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
    startedAt: string | null;          // the run's first claim (MP-6-2)
    endedAt: string | null;            // a hand-back with no claim after it
    tokenUnits: number | null;         // the run's model calls' units (0098)
    pins: { kind; path; digest; size; readAt; definitionVersionId; pinnedAt }[]; // pinned at run start (0086)
    reads: { sequence; path; digest; size; readAt; isEntry }[];  // the run's read ledger (0086)
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
    id; envelopeId;                    // the envelope it holds against (MP-6-5)
    runId;                             // the run it holds for: one per-run row
    state; heldMinor; actualMinor; classifiedCause; leaseId;
    lease: { id; fence; state; expiresAt; holderActorId } | null;
    attempt: { id; state; dispatchMarker; observed; dropCause; outcome } | null;
  }[];
}[]
```

`task.read` also carries `ledger`, the task's token ledger (MP-6-5), taken in
the same statement as the proposals so an envelope and the reservations
beside it are one snapshot:

```
ledger: {
  envelopes: {                         // the open one first, then closed, newest first
    id; state: 'open' | 'closed';
    maximumMinor;                      // the allowance
    heldMinor; actualMinor;            // held and spent against it
    currency; openedAt; closedAt;
    openedBy: { versionId } | null;    // the approval whose reservation opened it
    cap: { key; limitMinor; currency };// the cap it draws on
  }[];                                 // empty before any approval
  stops: {                             // AW-05's asks on the task's runs, oldest first
    askId; runId; number; kind: 'stop' | 'consolidated';
    ceilingMinor; spentMinor; currency; raisedAt;
    answer: 'top_up' | 'end' | null;
    awaitingSecond: { amountMinor } | null;
  }[];
  states: {                            // MP-6-2: each run's kept versions, newest first
    runId; version; knowledge: string[]; unknowns: string[];
    revisedBy: { actorId }; revisedAt;
  }[];
}
```

The per-run rows are the proposals' reservations: each names its envelope, and
the held reservations and the spent ones add up to its `heldMinor` and
`actualMinor`. It is read only and adds no audit event beyond the read's own.
It names the business's cap and its limit, so only an internal reader is shown
it: an agent's `task.read` answers `ledger: null` (I09).
The stops and the states are read through a run on this task in this
business, so nothing of another task's runs is read; the states are the
writer's text (`run.revise_state`), for a page to show as text.
The task page's Agent pane draws it as the token panel (DS-TASK-9): the
current envelope (the open one, else the newest closed), its reservations as
the per-run rows by `runId`, and the skills and data source its opening
version's stored evidence names (`skills`, `dataSource { label, href }`).

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

An agent credential (API-2) is the other bearer this prefix takes: the secret
a person issued on Settings ▸ Access, as `Authorization: Bearer`, with no agent
login behind it and no `X-Agent-Delegation`. It is told from a sign-in token by
its form and never reaches the provider's verifier, and this prefix never reads
a session cookie. Its security signals (S0-2) name it by the digest of its
digest (`credentialSubject`), the value its refused attempts are stored under,
never the stored hash or a slice of it. Its calls, reach and refusals are in
AUTHORITY.md, "Agent credentials (API-2)"; past a limit it answers
`AGENT_QUOTA_EXCEEDED` 429.

An agent login confers nothing on its own. With no `X-Agent-Delegation` header
it may read `task.queue` and call `task.pickup` (`BEFORE_PICKUP`,
`commands/agent-envelope.ts`, read off the surface rows whose `agent` is
`before-pickup`) and nothing else. `task.decide` answers
`DELEGATION_EXCLUDES_DECISION` 403, `task.triage`, the intake operation,
`DELEGATION_EXCLUDES_INTAKE` 403 (minimum contract 6.1: intake is reached only
inside a decision), and every other operation, `session.capabilities`
included, answers `DELEGATION_EXCLUDES_OPERATION` 403
(`authorise`; minimum contract 8.2 case 9). A credential that is presented and
answers to no live delegation is `DELEGATION_NOT_LIVE` 401. It is deliberately
one answer for unknown, expired, revoked and settled. Telling them apart tells a
caller holding a stolen credential which of those it is
(`resolveDelegation`, `authority/delegations.ts`). The one exception is a
delegation revoked because its person lost the authority it draws on, which
answers `DELEGATION_NARROWED` (R-B). A name outside `AGENT_SURFACE` is refused
`DELEGATION_EXCLUDES_OPERATION` before any of this, credential or not, and
`task.triage` `DELEGATION_EXCLUDES_INTAKE` (`runAgentCommand`). After a pickup
every call is intersected with the
delegation on the spot: the collection, the action, and a `scope` that must be
exactly the one task it was minted for.

| Answer                          | Status | When                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_NO_AGENT_IDENTITY`        | 401    | the login is not an agent login in this business                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AUTH_SESSION_EXPIRED`          | 401    | the bearer's signature verifies and its `exp` has passed, or its session is past the 12-hour limit or was ended (C58)                                                                                                                                                                                                                                                                                                                                  |
| `DELEGATION_NOT_LIVE`           | 401    | a presented credential that answers to no live delegation                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELEGATION_OUT_OF_PURPOSE`     | 403    | a sibling task, a collection or an action the purpose does not carry, or a call over the whole business (`task.create`)                                                                                                                                                                                                                                                                                                                                |
| `DELEGATION_NARROWED`           | 403    | the purpose reaches the call and the person's live grants no longer cover it, or the delegation was revoked for `authority_lost`                                                                                                                                                                                                                                                                                                                       |
| `DELEGATION_EXCLUDES_DECISION`  | 403    | `task.decide`, always: at the envelope with no credential, and from L4's `decideAsAgent` asking L2 under a delegation                                                                                                                                                                                                                                                                                                                                  |
| `DELEGATION_EXCLUDES_OPERATION` | 403    | any name not in `AGENT_SURFACE` but `task.triage`, whose seventeen members are the queue, a pickup, a handback, a heartbeat, a dispatch, an observe, a check, `task.read`, `task.comment`, `task.propose`, `task.create`, `task.decide`, `session.capabilities`, `model.call`, `run.revise_state` and AW-11's `run.delegate_child` and `run.child_handback`; or, with no credential, any name but the queue, a pickup, `task.decide` and `task.triage` |
| `DELEGATION_EXCLUDES_INTAKE`    | 403    | `task.triage`, always, with a credential or without one                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELEGATION_ALREADY_LIVE`       | 409    | a pickup under a purpose word the agent already holds a live delegation for                                                                                                                                                                                                                                                                                                                                                                            |

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
`FIELD_VALUE_INVALID` 422. Leave either out to take the default. A `report` or a
`successor` holding a NUL or an unpaired surrogate is `FIELD_VALUE_INVALID` 422
naming `report` or `successor.<key>`, and nothing is retained
(`handbackOperands`). A non-null
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
`session.capabilities` or `task.queue` replay is served again for the rights
held now (`serveAgain`), so a queue read before a pickup and repeated under a
delegation answers the narrowed queue (#169). A pickup replay is checked against the delegation it
minted (`replayPickup`). A handback settles its own delegation, so its receipt
is returned only to the credential that settled it (`replaySettledHandback`).
All three are in `commands/agent-replay.ts`. The register row is left as it
was. A request the register already holds is answered by `answerReplay` in the
same file, which releases a stored success through `releaseReplay`. An agent
call that does not apply ends in `settle` in `commands/envelope.ts`, which
writes the register row and the audit row, as a person's call does.

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
`tests/pickup/pickup-replay-lost-response.test.ts` holds the derived replay,
and `tests/pickup/pickup-replay-keys.test.ts` the legacy row and the key
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
client, shows an author or time there (`historyOf`, `reads/task-history.ts`).
Nor does its `history` name a person behind any actor: `personId` and
`actorName` are null on every entry, and only `actorId` and `actorKind` remain.
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

### `budget.record_outcome` (T3d1)

`POST /api/b/<key>/budget/record_outcome` with `recordId` (the task),
`attemptId` and `outcome`, one of `nothing_happened`, `happened` or
`happened_differently` (O7). It asks `decide` on `billing` for the task (O8:
any person holding it), and no agent route serves it
(`DELEGATION_EXCLUDES_OPERATION`). Only an attempt held `liability_unknown`
takes one; any other is `LIABILITY_NOT_UNKNOWN`. Nothing happened releases the
whole hold and resumes the work on a new hold; it happened spends the whole
hold; it happened differently spends it and reopens the work. A retry under the
same `operationId` replays the stored answer.

A planning reply (AW-04) held unknown has no task and no attempt: its form is
the conversation's id as `recordId` and the call's id as `attemptId`. Only the
conversation's owner reaches it; anyone else is answered `NOT_FOUND` with
nothing written. The owner must also hold `decide` on `billing` across the
business, checked again at the locked instant, else `SCOPE_NOT_GRANTED`.

The task page's Agent pane offers the three outcomes, and the write-off below,
on the newest attempt of the run it shows when that attempt is held
`liability_unknown` (C54): it sends the attempt id the read showed and reads
the task again after every answer. It offers no fourth outcome; an effect not
yet known keeps its stop. The top-up on the same page is `budget.top_up`'s own
control (T2e).

### `budget.write_off` (T3c)

`POST /api/b/<key>/budget/write_off` with `recordId` (the task), `attemptId`,
`amountMinor` (whole minor units from 0 to the hold: the reserved maximum, a
lesser figure the evidence shows, or nothing) and `reason` (a written reason,
up to 2,000 characters). It asks `decide` on `billing` for the task, and no
agent route serves it (`DELEGATION_EXCLUDES_OPERATION`). Only an attempt held
`liability_unknown` takes one; any other is `LIABILITY_NOT_UNKNOWN`. A positive
amount settles the hold at that figure, with the attempt's outcome left
`unknown`; nothing abandons it under the cause `written_off`. The envelope
gives the whole hold back either way; no attempt, hold or envelope row is
added and no work moves. When the hold is above the business's four-eyes
band, the first holder's call answers `awaiting_second_approver` and moves
nothing; a different live holder naming the same attempt and amount applies
it, and the first holder again is `FOUR_EYES_REQUIRED`. A retry under the same
`operationId` replays the stored answer.

### `budget.set_planning_cap` (AW-04, U10)

`POST /api/b/<key>/budget/set_planning_cap` with `limitMinor` (whole minor
units above zero), `currency` (the price book's, `AUD`) and `fromLimitMinor`
(the limit the caller last saw: AUD 50, `5000`, while nobody has moved the
default; `null` never matches). It asks `decide` on
`billing` for the whole business, so owners and administrators; a grant on one
task does not reach it, and no agent route serves it
(`DELEGATION_EXCLUDES_OPERATION`). It writes the business's `budget_caps` row
keyed `planning` and no other; the body names no key. A `fromLimitMinor` that
is not the current limit is `VERSION_STALE` 409 naming the limit it is at
(`limitMinor=<n>`, the default's `5000` while there is no row), as a settings write names its
revision, and two setters at once from one limit leave one applied. The answer is the cap's id
and `{ key: 'planning', limitMinor, currency }`. A lower limit is taken even
below what is committed: the next planning reply that no longer fits is
refused ([RUNTIME.md](RUNTIME.md#the-planning-budget)). Until a person moves
it the cap is AUD 50, and `settings.read`'s `planningCap` shows it. It holds
`billing:decide`, so C59's step-up asks it in the envelope: `STEP_UP_REQUIRED`
403 past 60 minutes while the business's money step-up setting is on.

## Tags

`task.read` carries `tags` (MP-4-11): the tags the task carries, `{ id, name }`
by name. `tag.list` is the business's vocabulary, asked as `task:read` of the
business, so a reader held to one client's records is refused rather than
shown the names every client's tasks carry.

`task.todos` is the reader's own to-dos (MP-7-1): the open tasks assigned to
the reader's person, on any board, soonest due first. Open is the rank's rule
(not completed, cancelled or archived). It is asked as `task:read` of the
business, the reader is a filter of the query, and each row carries its `tags`
and `waitingComments`, the client messages owed a reply by the team, derived
as `task.read` derives each message's signal. No agent reaches it.

Scoped (MP-7-2), it takes one of `person` (a teammate's open tasks) or
`client` (every open task under that client, whoever holds it), under the
same key and no other: `task:read` of the business already reaches every task
there, so a scope narrows the list and never widens it, and a reader held to
some records is refused before any person is looked up, told no count. A
person who is not an active member here (another business's included) is
`NOT_FOUND`, and so is a client that is not one of this business's
(another business's and a made-up id are one answer); a client here with
nothing open is an empty list.

`tag.create` takes `tag:write`, asked of the business: one name per business
whatever its case (a unique index on the lower-cased name, so two creates of
one name at once leave one). `task.add_tag` and `task.remove_tag` take
`task:write` on the task named in `recordId`, and a tag from the business's
vocabulary. Neither names a revision: a task's tag is a row beside the task.
Removing a tag from a task leaves it in the vocabulary. Each is audited under
its own name (`tag created`, `task.tag added`, `task.tag removed`). No agent
reaches them yet, although the key catalogue allows both keys inside a
delegation.

## Reads

`task.read`, `task.board`, `task.queue`, `gate.pending`, `task.ledger`, `task.search`,
`person.list`, `team.list`, `tag.list`, `task.todos`, `preset.plan`, `settings.read`,
`session.capabilities`, `access.read`, `inbox.read`, `inbox.count`, `inbox.unattended`,
`conversation.read`, `conversation.list`, `conversation.allowance`, `definition.attribution`,
`trace.read` and `harness.read` are declared in `COMMAND_SURFACE` with
`kind: 'read'`. The boundary branches on that and calls the executor the
composition root supplies:

```ts
executeRead(database, businessId, presented, request) => Promise<unknown>
```

exported as `executeRead` from `packages/core-commands/src/reads/execute.ts`,
returning either the contract's `{ ok: true, ... }` shape or a command refusal.
`executeRead` is a required option of `createApi`, so every declared read has
an executor.

`inbox.read` answers the caller's own items as `{ ok: true, inbox }`: every
open item, and the newest 50 closed ones (`INBOX_HISTORY_PAGE`) about a task
the caller reads now, oldest raised first. `inbox.count` answers
`{ ok: true, owed }`, the list's counted entries, counted in one query under
the same rule (`reads/inbox.ts`). Access is derived for every item inside the
read's own query, so neither read grows with a person's closed history. The
page of closed items is found from the caller's grants: each task they read
(the whole business on the history index; otherwise each task a grant names
or reaches through its client, on the per-task history index; both migration 0044) gives its newest 50, and the newest 50 of those are the page.
An item about a task the caller cannot read is never looked at for the page,
so it takes no place in it and another client's change never moves it. Those
items are read beside the page, newest first, from the page's oldest item on
and at most 200 closed items (`INBOX_HISTORY_SCAN`); the records read returns
them as withheld and the list does not show them. A readable entry about a planned run carries `alert`,
T2h's latest alert on that run (the same record, `id`, `kind`,
`waitingReason` and `raisedAt`, that the task page and the queue read show);
no other read carries it. A readable entry carries its pointers, its task's `key` and `title`,
and `closedBy`, the decider's `personId` and `name` once it is cleared, all
read in the same transaction, so the item stores none of them. It carries
`client`, its task's `clientId` and `name`, only where the caller reaches that
client as `client.list` does (MP-7-3's groups): a caller who holds the task
alone is not told its client. A gone entry
carries its own identity and axes and nothing of the task. The board screen
draws both reads above the board (`apps/web/src/views/inbox.tsx`, INB-1g).

The board's stream (INB-1f) is `GET <person prefix><business>/live` naming no
`topic`, or the same stream as the topic `board` on C4's one stream per tab
(`?topic=board` beside `task:<id>` topics, `apps/api/live-follow.ts`), where
every frame it sends is labelled `board` and names no task, and it ends alone
as a task topic does; the rest of this paragraph is its frames on its own route.
It sits beside T2f's
`/live/task/:recordId` and through the same door (`apps/api/app.ts`, `apps/api/live-board.ts`). The
join is `joinLiveBoard` (`reads/live-join.ts`): a person inside the business,
never an external reader or an agent, holding a live grant. It sends `resync`
on connect and after the listener reconnects, `invalidate` whose data is a
task's identifier only when the caller may read that task now (asked per event
as T2f asks `task.execution`), `inbox` with no data when what `inbox.read`
shows the caller changed (the topic names no item, so the stream compares a
digest of that read, `shownInbox`, and a change to an item the caller is not
shown says nothing), and `closed` the first time the join is refused again (at
every recheck, 30 seconds by default, and before each batch). The stream hears
the inbox of the person the bearer resolves to, asked at each batch and again
after each task read and each changed inbox digest, before its frame: if that is now another person,
the previous person's topic is dropped unsaid, the new one's is heard, and the
stream says nothing until its next recheck sends `resync`. The inbox topic is
`business:inbox:person`, sent at commit by migration 0043's trigger on
`inbox_items`, and the fan-out (`apps/api/live.ts`) hands it only to that
person's streams in that business. The web follows the `board` topic through the tab's one
hub: the board screen re-reads the board on `invalidate` and the inbox list and
count on `inbox`, the Inbox screen re-reads on either, and while the stream is
down the hub's 30-second floor re-reads them (`apps/web/src/data/board-live.ts`).

`task.read` carries the task's comments. An internal reader, meaning a
membership role of `owner`, `admin` or `member`, is given every comment in full.
Every other role is given `externalCommentProjection`'s answer, which is the
client comments in the fields the catalogue marks `shared` (`id`, `audience`,
`author`, `body`, `comment_type`, `posted_at`). External is the default, so a
role nobody classified sees the client view rather than everything.

A reader who is not internal on the person prefix gets a different key:
`{ ok: true, sharedTask: { id, revision, fields, comments } }`, never `task`
(the `serve` of the `task.read` row in `READ_CATALOGUE`, `reads/catalogue.ts`;
`SharedTaskView`, `reads/requests.ts`). `revision` is the record's version,
which an external party with a provisioned `comment` grant sends as
`expectedRevision` on `task.comment` (AUTHORITY.md, R4).
`fields` holds the task fields the catalogue marks `shared`. A shared task
shows its client `title` and `state` (Nathan's I09 ruling, OWNER-CARD section
6), both classified `shared` on the task spine (`tasks/spine.ts`). `state` is
shown as the state's label, never its identifier (`readSharedTask`,
`reads/tasks.ts`). Every other field stays `internal` unless the catalogue
classifies it. The classification lives in `field_defs`, which the seed writes
through `installTaskSpine` (`tasks/install.ts`), not a migration. A reseed
brings an earlier install forward: on an existing task type the installer sets
`title` and `state` to `shared` where they differ (`reconcileVisibility`,
`tasks/install.ts`), so an upgraded business shows both as a fresh
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
case (g) carries the rows. The server declares the two answers as
`TaskReadResult = InternalTaskRead | SharedTaskRead`
(`packages/core-wire/src/views.ts`), and the web imports that type
rather than keeping a copy; the two are told apart by the key.
`InternalTaskRead` also carries `states`: the business's live task states
in the workflow's order (`position`), each `{ id, key, label,
machineCategory }`, the status select's choices and the ids `task.set_state`
takes (`reads/task-states.ts`). It is served only with a found task; a
refusal, the shared answer and an agent's read carry none.

| Read                   | Route                   | Body                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Refusals it can answer                                                                                     |
| ---------------------- | ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `settings.read`        | `/settings/read`        | `{}`; it takes no fields | `{ ok: true, settings: [{ key, value, valueType, revision, updatedAt, updatedByActorId }] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `SCOPE_NOT_GRANTED` 403, `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 403                                |
| `session.capabilities` | `/session/capabilities` | `{}`; it takes no fields | `{ ok: true, personId, businessKey, grants: [{ collection, action }] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `SCOPE_NOT_GRANTED` 403, `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 403, `AUTH_SESSION_EXPIRED` 401    |
| `access.read`          | `/access/read`          | `{}`; it takes no fields | `{ ok: true, team, clients, agents, clientRecords, clientPrivacy }` (`clientRecords`: every client `{ clientId, name }`; `clientPrivacy`: each client's settings, C60): each person `{ personId, name, permissions: [{ collection, action, scope, stepUp }], grants: [{ grantId, collection, action, scope }] }` (`stepUp`: per key, the money step-up is asked before that key, by `asksMoneyStepUp`, C59; switching the money step-up off is asked on its own and is not marked; `grants`: their live grant rows in this business, each revocable by `access.revoke`), each agent its `person`, `purpose`, `expiresAt` and `permissions` | `SCOPE_NOT_GRANTED` 403 without `access:manage`, `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 403        |
| `session.person`       | `/session/person`       | `{}`; it takes no fields | `{ ok: true, person: { name } }`, the caller's own name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `FIELD_NOT_WRITABLE` 422, `COMMAND_BODY_INVALID` 400, `AUTH_NO_MEMBERSHIP` 403, `AUTH_SESSION_EXPIRED` 401 |

`session.person` and the command `session.end` are the person menu's (C23).
Neither asks the grant model: `session.person` answers anyone signed in with
their own name, a member holding no grant and a client outside the business
included, and `session.end` is `account:write` on the caller's own account,
which every signed-in person holds and nobody holds on another's
(`authorisedOn: 'self'`, `packages/core-wire/src/surface.ts`). Neither takes an
identifier, so a body naming a person, an actor or an account is refused rather
than read. `session.end` takes only `operationId`, answers
`{ recordId: null, detail: { ended: 'sign-out' } }`, and writes nothing but its
audit event, `session.end` on the business's chain naming the actor; the
browser ends the credential itself at the identity provider, with
`logout?scope=local`, so the person's other sessions stay signed in. Neither is
an agent's.

`settings.read` takes `read` on `settings` while the two settings commands take
`manage` on the same collection. The asymmetry is deliberate. A setting is a
business fact every member works against, and changing one is an authority
change. The four-eyes band is stored and shown. `settings.set_four_eyes_threshold` writes it
(`commands/settings-write.ts`) and `settings.read` returns it. Its consumers
are the top-up (`budget.top_up`, T2e), the write-off (`budget.write_off`,
T3c) and AW-05's top-up at the budget stop, `run.top_up`
([The answers at the budget stop](#the-answers-at-the-budget-stop)), which produce `FOUR_EYES_REQUIRED`. `task.decide` produces
`FOUR_EYES_REQUIRED` without the band since T2g: the person a task is assigned
to may not decide its gate. The seed gives
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
scope and never the first one's (`serveAgain`).
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
`task.board` takes `board`; `task.todos` takes `person` or `client`;
`task.queue`, `task.ledger`, `task.search`, `person.list`, `team.list`,
`tag.list`, `preset.plan`, `settings.read`, `session.capabilities` and
`access.read` take none. Any other identifier field, a `recordId` on any of
those twelve included, is `COMMAND_BODY_INVALID` 400 naming
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
Each history entry names who made the change (MP-4-16): `actorKind`
(`person`, `agent` or `worker`) and, for a person's actor, `personId` and
`actorName`, the person's display name, joined inside the business; the page
draws a person by name and the other two as "An agent" and "The system", never
an actor identifier. Only an internal reader gets the person: the agent
prefix, read as an outside reader, gets null for both.
`settings.read`, `session.capabilities` and `task.search` carry a null
subject: none is about one record, and naming one would make "who read this
record" false.

**`task.search` puts the caller's scope in the statement that finds
candidates** (ticket C1). The body is `{ query }`: up to 200 characters with at
least one word of letters or digits in them, else `FIELD_VALUE_INVALID` 422
naming `query`. The first eight words reach the index, each as a prefix, all of
them required; nothing else of the query reaches `to_tsquery`. `heldScopes`
(`authority/held-scopes.ts`) asks the grant model's own live expression which
`task:read` scopes the caller holds. The statement is handed the whole business
or the named records, and never reads a task outside them into the process.
The answer is `{ ok: true, hits: [{ id, key, title }] }`, at most 20, with no
count; `[]` means nothing in scope matched. A member holding no `task:read` is
refused `SCOPE_NOT_GRANTED` 403, never answered with an empty list. An external
party is refused `SCOPE_NOT_GRANTED` too, before anything is read: the portal
has no search until a client search is designed. `searchTasks`
(`reads/search.ts`) is the one function every caller of the index uses.
`tests/reads/search.test.ts` holds it. A server caller (the ledger's search,
MP-8-4) may pass `limit`, a whole number from 1 to 500, refused
`FIELD_VALUE_INVALID` naming `limit` otherwise before anything is read; its
answer adds `more`, whether the caller's own matches go past the limit, taken
from the same scoped statement. The `task.search` read passes none and stays
at 20 (`tests/reads/c1-search-past-cap.test.ts`).

One set is the exception: a person's own preferences are saved, read and
dismissed without an audit event (CS-2.8, MP-2-11a, MP-2-11). A successful
`preference.save`, `preference.read` or `preference.dismiss_tip` writes none,
and a refused one is audited like any other. The surface row's `audited: false`
says so; nothing else skips the chain.

**The layout is four keys of the one store** (MP-2-3, MP-3-2, MP-3-3):
`rail.width`, `dock.width` and `dock.sheetHeight` take a whole number of pixels
from 1 to 10,000, and `rail.collapsed` takes `true` or `false`.

**Guided tips are two keys of the one store** (MP-2-11). `tips.enabled` takes
`true` or `false` through `preference.save`. `tips.dismissed` holds one entry
per dismissed tip, `"<page>#<tip>": <version>`; a save of it takes only `{}`,
which is the reset. `preference.dismiss_tip` takes `{ page, tip, version }` (a
route id, a tip id of lower-case words and `-`, each up to 64 characters, and a
whole number from 1) and merges that one entry into the caller's own row in a
single upsert, so a dismissal made at the same moment on another device is
kept. A tip not already held is refused `FIELD_VALUE_INVALID` past 500. A tip
shows unless tips are off or its entry holds its current text version
(`tipShown`, `packages/core-wire/src/tips.ts`), so a rewritten tip comes back.

A `task.duplicate` entry (MP-4-8) also carries `duplicatedFrom`: the task it
was duplicated from, for a reader who holds read on that task now, and null
for anyone else, an agent included (`historyOf`, `reads/task-history.ts`). A
person of the new task's client learns that it was duplicated, not from where.
`settings.read` and `session.capabilities` carry a null subject: neither is
about one record, and naming one would make "who read this record" false.

**Show finished subtasks is a key of the one store** (MP-4-4, CS-4.27).
`subtasks.showFinished` takes `true` or `false` through `preference.save`;
hidden, the default, is no row. The task page and the dock panel read it once
and save each change; a reader the store refuses keeps the choice for the view
and sends no save.
The dock panel's trail fold is another (MP-4-8): `history.showTrail` takes
`true` or `false`; folded, the default, is no row.

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
- **An agent comments in the `internal` audience only.** The `task.comment` row
  passes `AGENT_AUDIENCES` (`commands/tasks-comment.ts`) to `writeTaskComment`,
  which refuses `client` as `AUDIENCE_NOT_PERMITTED`. An agent credential
  (API-2) reaches `commentOnTask` as its agent and gets the same set. This is
  Nathan's ruling (OWNER-CARD section 6), not an open item.
- **One lane choice awaits root or owner confirmation.** The heartbeat bounds are 1 hour a beat and 8 hours in total
  (`MAXIMUM_RENEWAL_SECONDS` and `MAXIMUM_LEASE_LIFETIME_SECONDS`,
  `core-runtime/src/heartbeat.ts`). Root ruling 6 at dd30aa8 covers bare agent
  calls and replay only, and does not confirm them.

## Verifying it

`node scripts/local/verify-slice.mjs` signs in through the local GoTrue with
the seeded passwords and walks create, start, complete, reopen and edit, then
the refusals: a foreign business writing a real and a fabricated id with their
bodies and timings compared, a login with no membership, a replayed operation
identity, a reused one, a stale revision, generic writes to protected fields, a
spoofed system field, and a body and headers carrying an actor and a business
that reach nothing. One line per case with the status and the code it observed;
a case that cannot run yet prints `unrun` with its reason.

## The second factor and the money step-up (C59)

The sign-in adapter (`apps/api/auth/supabase.ts`) passes the provider's
assurance through beside `sub`: the level (`aal`), and from `amr` the time of
the session's first sign-in (the earliest first factor) and of its latest
second factor. A refresh carries the
`amr` times unchanged, so the factor time is never renewed by one. A claim the
adapter cannot read is the lowest level, `aal1` with no factor time.

Login resolution refuses `AUTH_SECOND_FACTOR_REQUIRED` 401 when the sign-in
login has a verified second factor and the sign-in is below `aal2`. The factor
is the login's: verified through one business, it is required in every
business the login reaches, and removing it clears it in every one
(`ops.second_factor_subjects`, 0064, keyed by SHA-256 digests of the subject
and the provider's factor id). That holds on every person route except the
three below, which are how the sign-in gets its code.

A command whose declared key is in the money set (every `billing` key,
`offer:decide`, `mandate:manage`, `spend:decide`) is judged once, in
`prepare.ts`, straight after its grant check: a team member needs a second
factor verified in the last 60 minutes, a client a sign-in in the last 60
minutes, or it is refused `STEP_UP_REQUIRED` 403. A client's refusal names
`sign_in` and its first fix is "Sign in again with your password, then
retry."; a team member's names nothing and asks for the code from the
authenticator app. The web app asks the client for their password and signs
in again (`WEB.md`). While the business setting
`money_step_up_required` is `false` a live session is enough; only
`settings:manage` switches it, through `settings.set_money_step_up`, which is
judged the same way when switching it off, whatever the setting holds, so a
stale sign-in cannot switch the step-up off to move money. Switching it on
asks nothing, so a person without a factor can always turn it back on. An agent
credential never holds a money key (`credential.issue` below), so none is
judged later on an agent's behalf. Settings ▸ Access marks each such key
in a person's preview (`access.read`'s `stepUp`) by the same predicate,
`asksMoneyStepUp` (`authority/step-up.ts`), so the setting moves both at once.
The four-eyes threshold is one of these: `settings.set_four_eyes_threshold`
asks `spend:decide`, not `settings:manage` (MP-2-11).

A person's own factor has three routes on the person prefix only. Each is
served only when the composition root passes a `factors` provider
(`apps/api/auth/factors.ts`, GoTrue's MFA endpoints called with the person's own
bearer). Each writes one audit event, applied or refused, named by the act.
`enrol` is refused `FACTOR_ALREADY_ENROLLED` while the login holds a verified
factor through any business it reaches (0064), not only this one, and so is
`verify` on an enrolment here not yet completed, without asking the provider.
`remove` works where the factor was verified: another business holds no verified
factor of its own and answers `FACTOR_NOT_ENROLLED`. Replacing the app is a
`remove` with a code from the old one, then a new `enrol`; the web app opens
the removal when `enrol` answers `FACTOR_ALREADY_ENROLLED` (`WEB.md`).

| Route                    | Body                   | Answer                                                                                             | Refusals                                                                                                                                                                                                      |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/account/factor/enrol`  | `{}`                   | `{ factorId, qrCode, secret, uri }`, shown once                                                    | `FRESH_SIGN_IN_REQUIRED` 403 (no password sign-in in the last 60 minutes), `FACTOR_ALREADY_ENROLLED` 409, `VERSION_STALE` 409 (a newer enrolment recorded first), `PROVIDER_ANSWER_INVALID` 502               |
| `/account/factor/verify` | `{ code }`, six digits | `{ accessToken, refreshToken, expiresIn }` at `aal2`; completing an enrolment adds `otherSessions` | `COMMAND_BODY_INVALID` 400, `FACTOR_NOT_ENROLLED` 409, `FACTOR_ALREADY_ENROLLED` 409, `SECOND_FACTOR_INVALID` 422 (recorded as the failed attempt), `SECOND_FACTOR_LOCKED` 429, `PROVIDER_ANSWER_INVALID` 502 |
| `/account/factor/remove` | `{ code }`, six digits | `{ removed: true, otherSessions }`                                                                 | `COMMAND_BODY_INVALID` 400, `FACTOR_NOT_ENROLLED` 409, `SECOND_FACTOR_INVALID` 422, `SECOND_FACTOR_LOCKED` 429, `PROVIDER_ANSWER_INVALID` 502                                                                 |

Five wrong codes in fifteen minutes answer `SECOND_FACTOR_LOCKED` 429 on
`verify` and `remove` without asking the provider, so a caller holding only the
password cannot walk the six digits. The count is the login's, through every
business it reaches, since the provider holds one factor per login. The check
before a code goes to the provider takes the login's lock (a transaction-scoped
advisory lock on its subject's digest), counts the codes the login sent in the
window that the provider has not proved good (wrong ones, ones still at the
provider, and ones it answered `slow`, `unreachable`, `malformed` or
`oversized`, which it may still have checked), and, passing, records the code as sent before it commits, in
`ops.second_factor_codes` (0072) and as `account.factor_code_sent` in the
business's audit chain: requests sent at once, in any business, count each
other, and at most five codes reach the provider. Otherwise the check writes an
audit event only when it refuses; the act's own event is written after the
call, beside the record it changes, and carries the sent code's id as its
`operation_id`; a code the provider proved good is recorded as answered there
too, so it stops counting, and a provider fault on the code leaves it counted. GoTrue served under a path (`/auth/v1`) is called
under that path. The record step locks the login (a transaction-scoped
advisory lock, `second-factor-subject:` and its subject's digest), then the
person's own row (`for no key update`), so two tabs enrolling at once queue.
An enrolment replaces only the unverified factor it started from: one recorded
after it started (another tab's) stays the factor the first code completes, and
this one is refused `VERSION_STALE`, its provider factor reported as an
`account.factor_orphaned` event. One live factor remains. Two businesses
completing enrolments for one login at once queue too: the later is refused
`FACTOR_ALREADY_ENROLLED`, and the factor the provider has just verified for it
is removed there, best effort, so the login holds one verified factor.

`PROVIDER_ANSWER_INVALID` names only the kind of fault (`malformed`,
`oversized`, `slow`, `unreachable` or `refused`), never the provider's words.
The authenticator secret is in the enrol answer and nowhere else: not a log,
not an audit event, not the `second_factors` row.

A factor change (the first good code completing an enrolment, or a removal)
ends the person's other sessions (C58): here, in the change's own
transaction, then at GoTrue with `POST /logout?scope=others` and the `aal2`
session the code has just raised, the one kept. `otherSessions` is
`{ ended, signedOutAtProvider }`. A later code on a verified factor is a
step-up and ends nothing. A password change is made in the browser straight
with GoTrue; the sign-in surface ends the other sessions after it with the
route below.

A person's own sessions have three more routes beside these, on the person
prefix only, each with the body `{}` (anything else is `COMMAND_BODY_INVALID`
400). The list is the distinct sessions this business has served the person
in the last 12 hours, less the ended ones (GoTrue gives a person no list of
their own); nobody else's is ever read.

| Route                          | Answer                                                                                      | Served at                        | Audit event                   |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------- |
| `/account/sessions/list`       | `{ sessions: [{ sessionId, current, firstSeenAt, lastSeenAt }] }`, newest first, at most 50 | a full sign-in                   | none (a read of one's own)    |
| `/account/sessions/end-others` | `{ ended, signedOutAtProvider }`                                                            | a full sign-in                   | `account.sessions_end_others` |
| `/account/sessions/sign-out`   | `{ ended, signedOutAtProvider }`                                                            | any sign-in, before the code too | `account.sign_out`            |

Ending is recorded first, with its audit event, so the ended sessions are
refused from the commit. Then GoTrue's `POST /logout` is asked, with
`scope=others` or `scope=local` and the person's own bearer. Only a 204 with an
empty body counts as done; a 200, any body, a refusal, a redirect (never
followed), an oversized or slow answer is `signedOutAtProvider: false`, the
local end stands, and asking again is safe. The provider's words go nowhere.

In the web app, Settings ▸ General's "Your sessions" panel calls the first two,
ending the others only once confirmed, then listing again; it draws no session
id (`apps/web/src/screens/settings/sessions.tsx`).

## The operations view and privacy incidents (C55)

`operations.read` answers `{ ok, unattended, privacyIncidents, breachRunbook, securityAlerts, serviceHealth, errorSink, lastTestedRestore }`
to a holder of `operations:read` (install default: the owner and administrators). It is
never an agent's: on the agent prefix it is `DELEGATION_EXCLUDES_OPERATION` 403. Each incident carries its day-0 facts, its status and `assessBy`, 30 days
after `foundAt` (the breach runbook's assessment limit), most recently found
first, at most 200. The clock starts at `foundAt`, day 0, whenever the record
was made. `overdue` is true while an incident is open past `assessBy`, judged
on the database's clock (C81 breach drill). `breachRunbook` is what every
incident record links to: the breach runbook published most recently, as
`{ version, digest, publishedAt, body }`, or `null` until one is published.
`unattended` is INB-1's list, read for the same caller: exactly what
`inbox.unattended` answers them, built by the same read (no second list).

**Security alerts (TR-SEC-9).** `securityAlerts` lists the alerts S0-2's
forwarder raised, newest first, at most 50, each `{ kind, at, concerns }`:
the alert's kind, the time it was raised (ISO 8601) and fixed plain words for
what it concerns (`An alert of an unknown kind` for a kind the view has no
words for). It is read from the forwarder's log (`ops.security_alert_log`,
0069), written in the pass that raises the alert, so an alert stays listed
after the sink took it and its `ops.api_alerts` row is gone. No id, scope,
business, person, secret or record content is in it. An alert names no
business and the detector counts every business's signals together, so the
list is the installation's: only the business that operates it
(`ops.installation.operator_business_id`) reads it, and every other business,
or every business while none is set, reads `[]`.

`lastTestedRestore` is `{ at, stale }`: `at` the date of the last successful
tested restore (ISO 8601), or `null` while no drill has passed, and `stale`
true once that date is older than the store's restore window
(`backups.settings.restore_days`, the window past which the restore
heartbeat is withheld and the restore alert fires), or while none has passed.
The drill's receipt stays in the backup store, which the API cannot reach; a
pass the store took also stamps the date on the installation's database
(`ops.last_tested_restore`, [DATA.md](DATA.md)), and that is what this reads.
The service-health section is read outside the serving transaction, so the
age alone decides `stale`; nothing here asks the watcher a second time. The
date is installation state, the same in every business's answer, and carries
no business, person, archive or path.

`privacy.record_incident` is the tracked action `privacy incident recorded`,
under `privacy:manage` and never an agent's. Its body is
`{ operationId, whatHappened, foundAt, foundBy, affected, informationKinds }`:
text of 1 to 4000, 1 to 200 and 1 to 2000 characters, `foundAt` an ISO 8601
time no later than the server's clock (with five minutes' drift), and one or
more distinct kinds from `contact`, `identity`, `financial`, `health`,
`credentials`, `client-files`, `other`. A bad field is `FIELD_VALUE_INVALID`
422 naming the field alone; an undeclared one is `COMMAND_BODY_INVALID` 400.
The answer's detail is `{ incidentId, assessBy }`. The envelope audits the act
as a digest; the words are in `privacy_incidents` and nowhere else.

`privacy.draft_breach_notices` (C81 breach drill) is a read under
`privacy:manage`, never an agent's. It takes `{ incidentId, oaic, people,
containment, steps }`: `oaic` a recipient, `people` 1 to 500 of them, each
`{ name, address }` (1 to 200 and 1 to 500 characters, not blank), and
`containment` and `steps` 1 to 4,000 characters. It fills the published breach
runbook's "Template: notice to affected people" once for the OAIC (the runbook
says its statement carries the same content) and once per person, and answers
`{ ok, runbook: { version, digest }, notices }`, each notice `{ to: 'oaic' |
'person', name, address, subject, body }`, the OAIC's first. The date is the
day found, as the record holds it (UTC); the kinds are the incident's. It
writes nothing beyond its one audit event, which carries no recipient, and
sends nothing: the owner decides what is sent (owner line 54). A recipient or
address missing is `FIELD_VALUE_INVALID` 422 naming `oaic` or `people`, another
business's incident and a made-up one are `NOT_FOUND` 404, no published
runbook is `BREACH_RUNBOOK_UNPUBLISHED` 409, and a runbook with no template, or
one with a placeholder other than name, date, plain description, kinds,
containment and steps, is `BREACH_TEMPLATE_UNFILLED` 409.

**Service health (C34).** `serviceHealth` is the installation's watcher, error
sink and, where switched on, tracing: `{ checkedAt, sources, services }`. It is
read by the API only after the grant check lets the caller in, and outside the
serving transaction, so a refused caller asks no source; a read made in-process
(`executeRead`) carries none. Each source (`watcher`, `error-sink`, `tracing`)
is `read`, `read-failure` with its fault by kind (`unconfigured`, `refused`,
`malformed`, `oversized`, `slow`, `unreachable`), or `off`: tracing unset is
off, never a failure; the watcher and the error sink are not optional, so unset
is `read-failure` `unconfigured`. Each service a readable source reports is
`healthy`, `service-failure`, `stale` (last seen more than 15 minutes ago,
`HEALTH_STALE_SECONDS`, whatever it said then) or `never-observed`, with
`lastObservedAt`. A source is shown whole or not at all: an answer that throws,
takes over its time limit (3 seconds), or holds one bad entry (an empty or
over-long name, a control character, a time that is no time or more than a
minute ahead) is a read failure, and none of its services is shown. A client's
own site (`scope: 'client-site'`) is that client's and never shown here. The
source's own words go nowhere.

**Error sink link (C55).** `errorSink` is `{ url }`, the sink's web address
from `OPS_ERROR_SINK_URL`, or `null` when that is unset; the API adds it beside
`serviceHealth`, so a read made in-process carries none. The setting holds no
secret and is never derived from `OPS_ERROR_SINK_DSN`, whose user part is the
sink's key: an address that is not https, or that has a user part (a DSN
pasted there), stops the API at start, naming the setting and never its value.

The port is `HealthSource` (`reads/service-health.ts`). Tracing is Langfuse,
`LANGFUSE_HOST`, read at `GET /api/public/health` with no credential
(`apps/api/health/tracing.ts`): one destination, no redirect, a time and a size
limit; `{ status: "OK" }` on a 2xx is healthy, a status word on a 5xx is a
service failure, anything else a read failure. The watcher (UptimeRobot, C29-1)
and the error sink (GlitchTip, C29-3) are their adapters, filled in at the same
port when they land.

Held until their parts land (each placed here as its owner's read, never a
second list): security alerts (S0-2), the last tested
restore (S0-3) and the error-sink link.

## Legal documents (C81)

Each document is a run of versions: `client-terms`, `privacy-policy` (with its
collection notices), `data-handling` and `breach-runbook`. Three tracked
actions, each under `privacy:manage` and never an agent's:

- `legal.draft_version` (`legal document version drafted`) takes
  `{ operationId, document, version, body }`: a version `major.minor` and 1 to
  200,000 characters of words. Its detail is `{ versionId, digest }`, the
  digest being the SHA-256 of the words as stored. A version a document already
  has is `LEGAL_VERSION_EXISTS` 409: a change is a new version.
- `legal.approve_version` (`legal document version approved`) takes
  `{ operationId, versionId, digest }`. The digest is of the words the approver
  read; other words are `LEGAL_DIGEST_MISMATCH` 409, and a second approval is
  `LEGAL_ALREADY_APPROVED` 409.
- `legal.publish_version` (`legal document published`) takes
  `{ operationId, versionId }` and publishes only an approved version:
  otherwise `LEGAL_NOT_APPROVED` 409, and a second time
  `LEGAL_ALREADY_PUBLISHED` 409.

A bad field is `FIELD_VALUE_INVALID` 422 naming the field alone. A version of
another business and a made-up one are both `NOT_FOUND` 404.

`GET /api/public/b/<businessKey>/legal/<document>` needs no sign-in. It answers
the version of `client-terms`, `privacy-policy` or `data-handling` published
most recently, as `{ document, version, body, digest, publishedAt }`. No such
business, nothing published, the breach runbook and any other name all answer
`{ code: 'NOT_FOUND' }` 404. The privacy policy's answer also carries
`services`: the overseas-services register's rows in use when that version was
drafted, each `{ service, receives, where, trainsOnIt, contract }`, in the
register's order, and `dataClasses`: the data-class register's classes in use
when it was drafted, each `{ dataClass, purpose, disclosures, retention,
deletion }`, in the register's order.

### The client record and grants on Settings ▸ Access (C32)

`client.create` takes `{ operationId, name }` under `record:write`, never an
agent's, and answers `{ clientId }`. `name` is 1 to 200 characters, trimmed; a
name the business already has in any letter case is `CLIENT_NAME_TAKEN` 409. A
client is never renamed or deleted here.

`client.list` (`/client/list`, `{}`) answers `{ ok: true, clients: [{ clientId,
name }] }`: the clients the caller's live grants reach, asked inside the
query. A grant of any key over the whole business reaches every client; a grant
over one client reaches that client and no other, and the answer never counts
the rest. A caller holding no live grant is `SCOPE_NOT_GRANTED` 403; one whose
grants reach no client (a client person on a share) is answered an empty list.
Never an agent's.

`access.grant` takes `{ operationId, holderId, collection, action, clientId? }`
under `access:manage`, never an agent's, and answers `{ grantId }`. `holderId`
is a person of the business with an active membership; `clientId` is a client
of the business, or absent or null for the whole business. `collection:action`
must be a key of the permission key catalogue
(`packages/core-wire/src/permission-keys.ts`); the self-scoped `account`,
`credential` and `preference` keys are never granted. A malformed or unknown
field is `FIELD_VALUE_INVALID` 422 naming it; a person or client not of this
business is `NOT_FOUND` 404 naming `holderId` or `clientId`. The same key and
scope given again answers the live grant already held.

`access.revoke` takes `{ operationId, grantId }` under `access:manage`, never
an agent's, and answers `{ grantId, revokedAt, classifiedHolds }` as
`grant.revoke` does, with the same authority-loss classification. A grant not
live in this business is `NOT_FOUND` 404. The last business-wide
`access:manage` of a person who can sign in is `ACCESS_LAST_MANAGER` 409, on
this route and on `grant.revoke`.

`task.set_party`'s `client` must name a client of this business: another
business's or a made-up one is `NOT_FOUND` 404 naming `client`.

### A client's privacy settings (C60)

`client.set_privacy` takes `{ operationId, clientId, modelEgress, providers,
handlesHealth, noAgentEdits, requestedBy?, requestedOn?, requestLink? }` under
`privacy:manage` on that client (a grant over the whole business or over that
client), never an agent's, and answers `{ clientId }`. Every setting is sent
each time; a new client has all four off. `providers` names each of `claude`,
`chatgpt` and `replay` (the tests' stand-in, not a cloud model) at most once,
and none while `modelEgress` is false. Switching model use on (off to on, or to
other providers) takes the client's written request in the same command:
`requestedBy` (1 to 200 characters), `requestedOn` (`YYYY-MM-DD`) and
`requestLink` (1 to 2000); without all three it is `CLIENT_REQUEST_REQUIRED`
422, and a request sent with any other change is `FIELD_VALUE_INVALID` 422
naming `requestedBy`. A request is kept with what came of it, and kept when the
switch is refused: a cloud provider is `LOCAL_MODEL_REQUIRED` 501 ("personal
information stays out of cloud AI until a local model exists", owner line 72),
a client that handles health information `CLIENT_HANDLES_HEALTH` 409, and a
provider with no assessed row in use on the overseas-services register
`PROVIDER_NOT_ASSESSED` 409. A malformed field is `FIELD_VALUE_INVALID` 422
naming it. A client of another business answers as a made-up one: `NOT_FOUND`
404 to a business-wide holder, `SCOPE_NOT_GRANTED` 403 to a holder over one
client, as another client of the same business is. `access.read` carries
`clientPrivacy`, each client's `{ clientId, modelEgress, providers,
handlesHealth, noAgentEdits }`, and never the written requests.
`checkClientEditRun` (core-records) is the one check an edit run calls (C77,
C78): `CLIENT_NO_AGENT_EDITS` while "no agent edits" is on, else
`checkClientModelUse`'s answer for the run's provider.

### Ending a person's access (C58)

`access.end` takes `{ operationId, holderId }` under `access:manage`, never an
agent's: the tracked action `access ended (person: login, sessions, grants)`,
audited. In one transaction, under the access lock, the person's membership
and acting identity end, every live grant they hold and every delegation they
gave are revoked with one authority-loss classification, every agent
credential they issued in this business and not yet revoked is revoked by the
caller with its agent actor, and one access ending is written per login
mapped to them. It answers `{ personId, grantsRevoked, delegationsRevoked,
credentialsRevoked, classifiedHolds, endingIds }`. A person with no active
membership in this business, another business's included, is `NOT_FOUND` 404
naming `holderId`; a malformed id is `FIELD_VALUE_INVALID` 422. Ending the last
business-wide `access:manage` of a person who can sign in is
`ACCESS_LAST_MANAGER` 409.

From the commit the person's next call is `AUTH_NO_MEMBERSHIP` 403, whatever
the sign-in provider has done. Each ending owes the provider two steps, never
taken inside a transaction: end every session of the login, then deactivate
the login. Both are a 100-year ban through GoTrue's admin API
(`PUT /admin/users/<id>`), each done once the ban holds: GoTrue has no admin
call that ends a user's sessions, and it refuses a banned user's every refresh
and sign-in, so the ban is the session end (ORCH46). What access token is left
runs out within the hour and is refused here from the commit. GoTrue keeps a
banned user's sessions and refresh tokens, so an unban would revive them:
restoring access is a new login, never an unban (ORCH46). A provider user is
one person's across every business, while a login is one business's: while the
subject still has a live login in another business (mapped, its access not
ended there), both steps are stamped done with the reason `shared` and nothing
is sent, so ending access here never ends it there; the business that ends it
last bans (`loginLiveElsewhere`, on the owner's connection, answers yes or no). The calls carry the
admin key, `SUPABASE_SERVICE_KEY` (hosted, the project's service key; with none
set on a local stack, a five-minute `service_role` bearer signed with the local
auth key, minted per call); with neither, nothing is sent and both steps stay
owed. Sign-in never reads the key (`apps/api/server.ts`, `providerAdminKey`,
`goTrueLogins`). Every answer is shaped as C59's are
(`apps/api/auth/logins.ts`): one destination, no redirect, a time limit the
answer cannot stretch, a size limit, a shape per call; anything else is a fault
by its kind and the step stays owed. Where the server holds the provider key (the local server), the route tries
the act's own endings as soon as it commits. Hosted, the Vercel function holds
neither the key nor the owner login, and the endings loop (`pnpm endings`,
`apps/endings`, on the environment's machine beside the forwarder) asks for
every owed step each `ACCESS_ENDING_RETRY_SECONDS` (60): it reads business ids
and the shared check on the owner login only, and settles business by
business on the application login under each one's tenancy
(`retryAccessEndings`). `pnpm endings --once` runs one pass and exits 1 if it
failed, so a scheduler sees the backlog. It refuses to start without `DATABASE_URL`,
`DATABASE_ADMIN_URL`, `GOTRUE_URL` (https or loopback) and
`SUPABASE_SERVICE_KEY`. A 30-second claim on the row stops two retries
calling the provider at once, and a step done is stamped once and never asked
again (`settleAccessEndings`, `commands/access-end.ts`).

### Resetting a member's authenticator (C59)

`access.reset_factor` takes `{ operationId, holderId }` under `settings:manage`,
never an agent's: the tracked action `second factor reset (person, by)`,
audited against the caller with the member as its subject. It asks the
caller's own step-up, a sign-in with the second factor inside the last 60
minutes, whatever `money_step_up_required` holds (`STEP_UP_REQUIRED` 403). A
malformed id is `FIELD_VALUE_INVALID` 422; a holder with no active membership
in this business, another business's included, is `NOT_FOUND` 404 naming
`holderId`; a member with no verified factor here is `FACTOR_NOT_ENROLLED` 409.
The caller's own person, a member holding a business-wide grant the caller
does not hold (no reset upward: an owner may reset another owner, a peer an
equal-grant peer, never a lesser `settings:manage` holder the owner,
ORCH66-FACTORM2), a member whose sign-in login is not exactly one, and a login
still live in another business (mapped there, its access not ended) are
`FACTOR_RESET_REFUSED` 409, in one set of words for every reason, which never
say where else the login is; nothing is written or sent.

In one transaction, under the access lock, the member's live factor is
recorded removed (here and by subject, 0064), every session of theirs is ended
(0057, 0063), and one reset row owes the provider GoTrue's admin removal of
that factor (`DELETE /admin/users/<subject>/factors/<factor id>`, 20261004091551). It
answers `{ resetId, providerStep }`: `owed` from the act, `done` when the local
server, holding the admin key, sent the removal as soon as the act committed.
Hosted, the endings loop sends it each `ACCESS_ENDING_RETRY_SECONDS`
(`retryOwedSteps`, beside the access endings). Each owed row is claimed for 30
seconds just before its own call, so two settles never call at once for one
reset and a slow pass never lets a later row's claim lapse; done is stamped
once and never asked again, and an answer that comes back after the row is
done stamps nothing. Done is the factor named back by its id, or GoTrue's 404
with `error_code` `mfa_factor_not_found` (the factor already gone, an earlier
answer lost); anything else, any other 404 included, is a fault by its kind
alone, with the step left owed (`settleFactorResets`,
`commands/factor-reset-settle.ts`). The live-elsewhere check runs inside the
command's transaction through `public.factor_login_live_elsewhere(login)`, a
security definer that takes a login id of the transaction's own business,
never a subject, reads the subject itself and answers one boolean: true with
no business set or an id that is not a login here. PUBLIC may not execute it;
the application role may. Any path that ever maps a login into a business must
first take the `second-factor-subject` lock the reset holds, so the check
holds to the commit.

### The overseas-services register (C81, SP-25)

`privacy.set_overseas_service` takes `{ operationId, service, receives, where,
trainsOnIt, contract, toConfirm, inUse }`, every field each time, under
`privacy:manage` and never an agent's. It sets the row of that service (its
name matched in any letter case) and answers `{ serviceId }`; each change is
its own audited operation. `service` is 1 to 120 characters, `receives` 1 to
2,000, the other three 1 to 1,000; `toConfirm` and `inUse` are booleans. A bad
field is `FIELD_VALUE_INVALID` 422 naming the field alone. A service no longer
used is set `inUse: false` and kept.

A privacy-policy draft takes the register's rows in use and their digest with
it. Approving or publishing that version is `LEGAL_REGISTER_CHANGED` 409 once
the register has changed since the draft (draft again), and
`LEGAL_REGISTER_UNCONFIRMED` 409 while any of its rows is `toConfirm`. The
other documents do not read the register.

### The data-class register (C81)

`privacy.set_data_class` takes `{ operationId, dataClass, purpose,
disclosures, retention, deletion, inUse }`, every field each time, under
`privacy:manage` and never an agent's. It sets the row of that class of
personal information (its name matched in any letter case) and answers
`{ dataClassId }`; each change is its own audited operation. `dataClass` is 1
to 120 characters and the other four 1 to 2,000 each, all required, so a class
missing its purpose, disclosures, retention or deletion is refused; `inUse` is
a boolean. A bad field is `FIELD_VALUE_INVALID` 422 naming the field alone. A
class no longer held is set `inUse: false` and kept.

A privacy-policy draft takes the classes in use and their digest with it.
Approving or publishing that version is `LEGAL_DATA_CLASSES_CHANGED` 409 once
the classes have changed since the draft (draft again). The other documents do
not read the classes. C62's retention table and the privacy-request workflows
read the same rows through the records package (`readDataClasses`).

## Agent credentials (API-2)

Two tracked actions on the person prefix only, each under `credential:write`
and never an agent's (an agent is refused `DELEGATION_EXCLUDES_OPERATION`):

- `credential.issue` (`agent credential issued`) takes
  `{ operationId, scope, expiresAt, purpose }` and issues a credential of the
  caller's own. `scope` is 1 to 32 distinct `{ collection, action }` keys, each
  held by the caller at business scope (otherwise `CREDENTIAL_SCOPE_WIDENS` 403) and never `decide`, `share` or `manage` (`CREDENTIAL_ACTION_EXCLUDED`
  403). It never holds a money key (C59's set, `billing:read` included): an
  agent may hold none (`docs/design-system/CAPABILITY-SLICES.md`), so a scope
  with one is `CREDENTIAL_MONEY_KEY_EXCLUDED` 403 on any sign-in. `expiresAt` is an ISO 8601 UTC time after now and at most 90 days out.
  `purpose` is 1 to 200 characters. Its detail is
  `{ credentialId, agentActorId, scope, expiresAt, credential }`.
  `credential` is the secret, in this answer only; the register keeps it null.
  The same operation replayed by the issuer answers the same secret while the
  credential is live, and `credential: null` once it is revoked or expired; a
  live one holding a money key, issued before that rule, is
  `CREDENTIAL_MONEY_KEY_EXCLUDED` 403.
- `credential.revoke` (`agent credential revoked`) takes
  `{ operationId, credentialId }`. The issuer revokes their own; anyone else
  needs `access:manage` too. A credential of another business, a made-up one,
  and another person's without `access:manage` are all `NOT_FOUND` 404; a
  second revocation is `CREDENTIAL_ALREADY_REVOKED` 409. Its detail is
  `{ credentialId }`.

A bad field is `FIELD_VALUE_INVALID` 422 naming the field alone; no refusal,
detail or audit event carries the purpose or the secret. Using a credential on
the agent route waits on S0-6's bearer scheme.

## The first-client gate (S0-5)

An installation is made-up or real (`ops.installation`, migration 0058).
Every command the catalogue classes `client-data` or `invitation` reads
`public.first_client_readiness()` inside its own transaction, after
authority and before the handler, on the person and agent routes. On a
real-data installation with any gate item open it is refused `GATE_SHUT` 409,
naming the open items, and writes nothing. A made-up-data installation, the
test harness and staging included, runs them. An installation with no mode
row refuses them too, naming `installation`, and one whose readiness function
is gone fails them. Only a database from before 0058, with neither the
function nor `ops.installation`, runs them, as 0058 provisions it made-up.

`task.share_with_client` is `client-data` (MP-4-10): a share gives the task to
the client's existing people and enrols or invites no one, so it is shut while
an item is open and is never an `invitation`. `task.revoke_client_share`
gives no one anything and is not gated.

The eight items are `ops.gate_items` rows, each with an `https` evidence link:
`tested-backups`, `second-factor`, `legal-basics`, `privacy-act-statement`,
`overseas-register`, `breach-runbook`, `security-pass`, `phone-alerts`. Three
closing lines are rows too (migration 0060), each with the owner's one line
(`statement`, at most 500 characters, no line breaks) as well as its link, and
open until recorded like any item: `privacy-opt-in` (the link is the OAIC's
public Privacy Opt-In Register page, where the entry is listed; a lodged form
or a receipt is refused; the line says the published policy matches it),
`cloudflare-rolled` (the link shows the old credential refused; the line
records the new one in custody) and `training-line` (item 5's dated line that
model training is off on both model accounts, carrying a real `YYYY-MM-DD`
date, with its evidence link). The eight items carry no line. Item 3's tested
manual privacy-request procedure has a line of its own (migration 0071),
`privacy-procedure`: the procedure's dry run ([PRIVACY-RUNBOOK.md](PRIVACY-RUNBOOK.md)),
recorded with its `https` link and no owner's line, and open until recorded,
so item 3 done does not close it. The table holds the same rules. The mode
moves from made-up to real only while every item and line is done, and never
back; the row cannot be deleted.

Two commands move the gate (migration 0059), each a person's under
`operations:manage` in the business that operates the installation
(`ops.installation.operator_business_id`, set at provisioning), never an
agent's or a delegation's; any other caller, and every caller while no business
operates it, is refused `SCOPE_NOT_GRANTED` 403 and writes nothing:

- `operations.record_gate_item` takes `{ operationId, item, evidence,
statement? }`: one of the eight items, three closing lines or the procedure
  line, one `https` link of at most 2000 characters with no spaces, and the
  owner's line on a closing line only, each refused `FIELD_VALUE_INVALID` 422 naming the field.
  Items 3 to 6 take only the link to their document's version published in the
  operator's business, pinned to its version and digest (C81): `legal-basics`
  and `overseas-register` the privacy policy's, `privacy-act-statement` the
  data-handling statement's, each `https://<host>/legal/<businessKey>/<document>/?version=<v>&digest=<sha256>`,
  and `breach-runbook` the runbook's, `https://<host>/settings/operations/?runbook=<v>&digest=<sha256>`,
  where the runbook fits on one page (1,000 words). A link with a user name,
  password, port other than 443 or fragment is refused; the host is not
  checked, since commands are not told the served host. Any other link, or none
  published, is refused `FIELD_VALUE_INVALID` 422 naming `evidence`. An item is
  recorded once; a second record is refused `GATE_ITEM_ALREADY_RECORDED` 409
  and the first evidence stays.
- `operations.change_installation_mode` takes `{ operationId, mode: 'real' }`.
  While any item is open it is refused `INSTALLATION_NOT_READY` 409 naming
  them; `mode: 'made-up'` is refused `INSTALLATION_MODE_ONE_WAY` 409; an
  installation already real answers `ok` and changes nothing.

The application's role reads both tables; it may insert a gate item and update
the mode alone, and nothing else, and it writes them only through these two
commands.

## A task's client is locked once it has content (S0-5)

`task.set_party` changes a task's client only while the task is empty: its
history (applied audit events about it) holds nothing beyond its creation and
earlier client changes, and no row names it (a subtask naming it as its parent, a
proposal, a planned run, an envelope, a lease, an alert, or a time entry,
deleted or not). Otherwise it is
refused `CLIENT_LOCKED` 409 and writes nothing, on the API and the command
line alike. The check runs under the task's row lock, so a content write
holding that lock lands wholly before it (the change is refused) or wholly
after it (the write is stale against the change's revision and retried). A
trashed task still answers `NOT_FOUND`.

## Workflow triggers (C33)

Settings ▸ Workflow triggers: one read on `settings:read`, and two changes,
each held business-wide and never an agent's. `activation.change` is
`settings:manage`; `definition.release` is `automation:manage` (the key
catalogue: owner and administrators). Definitions carry no client, so the
registry is the business's; a holder at one client's scope is refused all
three (`tests/automations/c33-authority.test.ts`).

A person releases a definition version: the first release names a new
definition by `name` and `kind`, a later one names it by `definitionId`. The
version takes the next number, pins its bytes by digest and size, and lists
its inputs, its operations and the activation modes it permits. It never
changes after release (`definition_versions`, migration 20261005003850). Two
releases at once on one definition both land, on distinct numbers: the one
that finds its number taken asks again in its own transaction. The digest and
size are the caller's until AW-02's pinned read computes them from the bytes.

An activation is pinned to one version of its own definition, in a mode that
version permits (checked by the command and again by the database). Without an
`activationId` the change writes a new activation; with one it changes that
activation at the revision the caller read, compared in the update itself, so
two changes sent at one revision apply once. Changing a mode starts nothing:
no occurrence and no planned run, since a run needs an occurrence and C52-A's
standing approval.

Every value is checked against a closed grammar before anything is written,
and refused `FIELD_VALUE_INVALID` naming its field: a digest is 64 lower-case
hex digits, a mode, kind or mode list comes from its fixed set, an operation
or event kind is a dotted lower-case name, and a name or an input's key or
value is at most 200 characters of storable text (an allow-list of code points:
no control character, line break, bidi mark or override, or lone surrogate).
Another business's definition, version or activation answers exactly as a
fabricated identifier does.

| Operation             | Route                  | Body                                                                                        | Answer or refusals                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automation.registry` | `/automation/registry` | `{}`                                                                                        | `{ ok: true, definitions: [{ id, kind, name, versions: [{ id, number, contentDigest, contentSize, modes, releasedBy, releasedAt }], activations: [{ id, versionId, versionNumber, mode, everyMinutes, eventKind, enabled, changedBy, changedAt, revision }] }] }`; `SCOPE_NOT_GRANTED` 403 |
| `activation.change`   | `/activation/change`   | `{ activationId?, versionId, mode, everyMinutes?, eventKind?, enabled, expectedRevision? }` | `{ activationId, versionId, mode, enabled }`; `FIELD_VALUE_INVALID` 422 naming the field; `NOT_FOUND` 404; `TRANSITION_NOT_PERMITTED` 409 for a mode the version does not permit or another definition's version; `VERSION_STALE` 409                                                      |
| `definition.release`  | `/definition/release`  | `{ definitionId? \| name, kind, contentDigest, contentSize, inputs, operations, modes }`    | `{ definitionId, versionId, number }`; `FIELD_VALUE_INVALID` 422 naming the field; `NOT_FOUND` 404 for a definition not in the business; `VERSION_STALE` 409 when three releases in a row find their number taken                                                                          |

## Custody (C31)

Three rows, `custody:manage` each and never an agent. [CUSTODY.md](CUSTODY.md)
has the table, the sealing and the compromise runbook.

| Operation      | Route           | Body                                                                                                | Answer or refusals                                                                                                                                                                                                                                         |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret.list`  | `/secret/list`  | `{}`                                                                                                | `{ ok: true, secrets: [{ id, name, clientId, state, setAt, lastUsedAt, revision }], canChange }` (`canChange`: the key is held business-wide); `SCOPE_NOT_GRANTED` 403                                                                                     |
| `secret.set`   | `/secret/set`   | `operationId`, `name`, `value` (one line of 8 to 8192 characters), `clientId?`, `expectedRevision?` | `detail: { secretId, name, clientId, state }`; `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404 (`clientId` not this business's), `VERSION_STALE` 409, `GATE_SHUT` 409 (real data, first-client gate open), `FIELD_VALUE_INVALID` 422, `DEPENDENCY_NOT_LANDED` 501 |
| `secret.clear` | `/secret/clear` | `operationId`, `secretId`, `expectedRevision?`                                                      | `detail: { secretId, state }`; `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `VERSION_STALE` 409                                                                                                                                                               |

No answer carries a value, and a refusal names the field, never what was sent.
No audit row holds a set's value either, a refusal's attempted values included.
A set's `expectedRevision` is the revision `secret.list` showed, or `0` for a
name the list did not hold: `0` is refused `VERSION_STALE` when the name exists.
