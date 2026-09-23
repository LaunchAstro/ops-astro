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
commit. The last two are the seed's: the agent identities each business gets,
with the password each signs in to GoTrue with, and the key decisions are
signed with — generated once and read back, because a second seed minting a new
secret would leave every decision already on the chain signed by a key this
deployment no longer holds.

## Routes

Every route is `POST /api/b/:businessKey` + the command's path, and every path
is derived from `COMMAND_SURFACE`: `task.create` is `/api/b/alpha/task/create`.
Nothing is written out by hand, so an operation another part declares becomes
reachable with no edit to the API, and a command with no declaration has no
route to be reached through.

`GET /api/health` is the one exception. It runs a statement and answers from
the result: `200` with `database: "reachable"`, or `503` with
`database: "unreachable"` and the reason. It also reports whether the read half
of the surface is mounted.

| Body               | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `operationId`      | Required on every mutation. The repeat-request identity.           |
| `expectedRevision` | Required on a command with an existing record to be stale against. |
| `fields`           | The values the command owns. Reads take neither of the two above.  |

A success is the envelope's outcome — `recordId`, `revision`, `detail`. A
refusal is `{ code, names, fixes }` under the status `apps/api/status.ts` maps
the code to. The code is what a client branches on; the status is what a proxy
and a log reader see, and neither is derived from the other.

**An absent or mistyped operand is refused by name, not answered as a fault.**
Five operations used to take their request type at its word and answer a
plain-text 500 when an operand was missing. Each now answers
`FIELD_VALUE_INVALID` 422, naming the operand, with a fix line
(`packages/core-records/src/commands/operands.ts`):

| Operation      | Operand                                  | What it has to be                                                        | Checked at                                 |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `task.create`  | `fields`                                 | an object of field keys to values, not an array                          | `commands/tasks-write.ts:90`               |
| `task.restore` | `batchId`                                | a non-empty string, the one `task.trash` answered                        | `commands/tasks-trash.ts:57`               |
| `task.purge`   | `olderThanDays`                          | a whole number of days, zero or more                                     | `commands/tasks-trash.ts:80`               |
| `task.read`    | `recordId`                               | a string                                                                 | `apps/api/app.ts:183`, `operands.ts:63-65` |
| `preset.plan`  | `recordTypeKey`, `presetKey`, `fields[]` | two non-empty strings, and an array of field objects, which may be empty | `apps/api/app.ts:183`, `operands.ts:66-77` |

The three command checks run in their handlers, so the refusal is registered and
audited like any other command refusal. The two read checks run at the
boundary, after the membership check and before the read executor, so they come
before the grant check and **write no read audit row yet**: the audited home
for them is the read dispatcher, and they have not moved there on this head.
`tests/api/operand-refusals.test.ts` holds all five over HTTP, absent and
mistyped, and that a well-formed request still succeeds on each. On the agent
prefix, `task.read` reads `recordId` through the agent envelope and not this
boundary check.

## Who is calling

`Authorization: Bearer <GoTrue access token>`. The adapter verifies the HS256
signature and `exp` with `SUPABASE_JWT_SECRET` and takes `sub` as
`VerifiedSubject { provider: 'supabase', subject }`.

Nothing else reaches identity. Not a body field, not a host or forwarded
header, not an `apikey`, not a query parameter. A request carrying `actorId` or
`businessId` alongside its token is a request with those fields nowhere to go.
A missing, forged, unsigned or subject-less token all answer
`AUTH_UNKNOWN_LOGIN`, because telling them apart tells an unauthenticated
caller which guess was closer. An **expired** token is the one exception and
answers `AUTH_SESSION_EXPIRED` 401: it is not a guess, since its signature
verifies against this deployment's own secret, so the caller learns nothing
they could not already prove and gains the re-login path.

The business is named by the path and verified by login resolution. A business
the caller is not a member of and a business that does not exist both answer
`AUTH_NO_MEMBERSHIP`, for the same reason an unmapped subject and a missing
login refuse identically: the difference is an inference across a tenancy
boundary.

The algorithm is named when verifying rather than read from the token's own
header, so a token nominating `alg: none` verifies against no key at all.

## What the boundary is not

It holds no authority check. Every refusal in a response came back from the
operation, inside the serving transaction, through the grant path. There is no
check here to remove, because there is none here.

It reads no record. The only statement it causes outside `withBusiness` is the
business-key lookup in `server.ts`, which reads one column of one row: the
tenancy root sits behind forced row security keyed on a setting the serving
transaction has not set yet, so that one mapping has to precede tenancy. Every
statement after it runs through the wrapper.

## The operations L2 made possible

Four rows joined the surface when L2's model modules landed, and one came off
the pending list. Each reaches the API and the command line by generation, so
there is no route written out for any of them.

| Operation                          | Route                               | Body                                                                              | Refusals it can answer                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.comment`                     | `/task/comment`                     | `operationId`, `recordId`, `expectedRevision`, `body`, `audience`, `commentType?` | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404, `VERSION_STALE` 409, `DEPENDENCY_NOT_LANDED` 501 where a business has no comment type                                                     |
| `preset.plan`                      | `/preset/plan`                      | `recordTypeKey`, `presetKey`, `fields[]`                                          | `FIELD_VALUE_INVALID` 422 for an absent or mistyped operand, `SCOPE_NOT_GRANTED` 403, `PRESET_FIELD_UNCLASSIFIED` 422, `PRESET_TYPE_UNKNOWN` 404, `PRESET_FIELD_UNPLACEABLE` 409, `PRESET_FIELD_DUPLICATE` 422 |
| `settings.set_four_eyes_threshold` | `/settings/set_four_eyes_threshold` | `operationId`, `value` (number or `null`), `expectedRevision?`                    | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                                                       |
| `settings.set_client_sign_off`     | `/settings/set_client_sign_off`     | `operationId`, `value` (boolean), `expectedRevision?`                             | `SCOPE_NOT_GRANTED` 403, `VERSION_STALE` 409, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                                                       |

`task.comment` writes a comment record beside the task and leaves the task's
own revision alone, so a caller may keep writing against the revision they
hold. The author is the acting actor and the posting time is the server's;
neither is a payload field.

`preset.plan` is declared `kind: 'read'` because it writes nothing at all,
including on success. It is the one read that does not take the `read` action,
which is why the collection and the action are on the declaration rather than
assumed from the kind.

**The grant `preset/plan` needs is `manage` on the family the request names,
not on `preset`.** A body with `recordTypeKey: "task"` takes `manage` on
`task`; planning a preset into another family takes `manage` on that family.
A caller holding a blanket `manage` on `preset` and nothing else is refused
`SCOPE_NOT_GRANTED` 403, naming the family they are missing. The planner
bounds itself to the owned family, and the route asks the same question in
front of it rather than a wider one, so the two cannot disagree about who may
plan what.

A preset that names one new field key twice is refused `PRESET_FIELD_DUPLICATE`
422 naming the repeated keys, before any action is planned: two entries
claiming one key cannot both be created, and a plan promising something the
apply cannot do would be worse than a refusal. Nothing is written, as with
every other refusal here and with every success.

The two settings commands take an **optional** `expectedRevision`, which
migration `0020_business_settings_revision.sql` made possible: `business_settings`
now carries a revision, `settings.read` projects it on every setting, and a
write naming a revision the row has moved past is refused `VERSION_STALE` 409
with `names = ['revision=<current>']` and the stored value unchanged. It is
optional rather than required because a caller who has not read the setting is
still allowed to set it; omitting it is a last-writer-wins write, and naming it
is the optimistic check. The applied result carries the `revision` the row is
now at, which is the one the next write names. How the writer locks and moves
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

## The operations L4's runtime made possible

`NOT_LANDED` is empty. Nothing in `COMMAND_SURFACE` answers
`DEPENDENCY_NOT_LANDED` because a part it rests on has not been built.

| Operation       | Route            | Body                                                                                                                                       | Refusals it can answer                                                                                                                                                                                                                                 |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task.propose`  | `/task/propose`  | `operationId`, `recordId`, `expectedRevision`, `purpose`, `maximumMinor`, `currency`, `payload`, `step`, `expiresInSeconds?`, `lineageId?` | `SCOPE_NOT_GRANTED` 403, `PROPOSAL_OUT_OF_SCOPE` 403, `LINEAGE_TERMINAL` 409, `LINEAGE_NOT_ON_TASK` 409, `CHANGE_ROUNDS_EXHAUSTED` 409, `VERSION_STALE` 409, `NOT_FOUND` 404, `FIELD_VALUE_INVALID` 422                                                |
| `task.decide`   | `/task/decide`   | `operationId`, `gateId`, `versionId`, `decision`, `note`                                                                                   | `GATE_NOT_FOUND` 404, `GATE_ALREADY_DECIDED` 409, `GATE_EXPIRED` 410, `VERSION_SUPERSEDED` 409, `EVIDENCE_MISMATCH` 409, `LINEAGE_TERMINAL` 409, `BUDGET_UNAVAILABLE` 409, `BUDGET_EXHAUSTED` 402, `CAP_BINDING_MISMATCH` 409, `SCOPE_NOT_GRANTED` 403 |
| `task.pickup`   | `/task/pickup`   | `operationId`, `reservationId`, `leaseSeconds?`                                                                                            | `AUTH_NO_AGENT_IDENTITY` 401 on the person path, `RESERVATION_NOT_CLAIMABLE` 409, `DELEGATION_ALREADY_LIVE` 409, `DELEGATION_WIDENS` 403, `FIELD_VALUE_INVALID` 422                                                                                    |
| `task.handback` | `/task/handback` | `operationId`, `leaseId`, `fence`, `outcome`, `report?`, `actualMinor?`, `successor?`                                                      | `AUTH_NO_AGENT_IDENTITY` 401 on the person path, `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `SUCCESSOR_OUT_OF_BOUNDS` 409, `ACTUAL_EXPENDITURE_UNSUPPORTED` 422, `FIELD_VALUE_INVALID` 422                                                            |
| `task.queue`    | `/task/queue`    | nothing; it is a read                                                                                                                      | `SCOPE_NOT_GRANTED` 403                                                                                                                                                                                                                                |

`task.propose` answers `FIELD_VALUE_INVALID` 422 for the two shapes its columns
constrain, **before** the write rather than at it: a `purpose` outside
`^[a-z][a-z0-9_]{0,62}$` names `purpose`, and a `step` that is not
`{ kind, payload }` with a non-empty `kind` and an object `payload` names
`step`. Both used to reach the database and arrive as `SERVICE_UNAVAILABLE`
503, which tells a caller their server is broken when their request was.

`task.propose` writes a proposal beside the task and leaves the task's own
revision alone, so a caller may keep writing against the revision they hold.
The proposer, the subjects and the expiry instant are the server's: a body
naming an absolute `expiresAt` could raise a gate nobody can decide or hold a
ceiling open for a decade, and a duration the server adds to its own clock can
do neither. `expiresInSeconds` is a whole number from 1 to 604800: maximum
seven days (owner decision, 23 Sep 2026), and leaving it out takes seven days.
604801, zero or a fraction is `FIELD_VALUE_INVALID` 422 naming
`expiresInSeconds` and the maximum, and it writes nothing but its refused
audit row (`tests/api/expiry-bound.test.ts`). Existing gates are not
rewritten.

`task.decide` names the **exact version** it is deciding. It is compared under
the locks and never trusted, so a decision made from a page that has gone stale
is `VERSION_SUPERSEDED` rather than a decision about something the decider
never read. The signing key and the budget cap are not in the body: the key
comes from the deployment's environment and the cap is the business's own,
read rather than created, because a command that created the ceiling it then
spent against could never be refused `BUDGET_EXHAUSTED`.

Three of those codes arrived with lane L4-RUNTIME-FIX and are registered here
with the statuses the runtime suggests. `LINEAGE_NOT_ON_TASK` 409 is
`task.propose` naming a `lineageId` that belongs to a different task in the
same business — the caller may hold it legitimately and it is still not this
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

`task.handback` takes an **optional** `successor`, which is how a worker that
has finished one piece of work proposes the next without a person having to
open the task again. Its caller-supplied half is
`{ purpose, maximumMinor, currency, payload, step: { kind, payload }, expiresInSeconds? }`.
`expiresInSeconds` is the same duration `task.propose` takes, read through the
same `expiryFrom`: maximum seven days (owner decision, 23 Sep 2026), and
leaving it out takes seven days. Over the maximum is `FIELD_VALUE_INVALID` 422
naming `successor.expiresInSeconds`, and it settles nothing. An absolute
`successor.expiresAt` is refused by name.
`proposedByActorId` is **not** a body field: it is the agent actor of the
session, and a caller who sends it — under either spelling — is refused
`FIELD_NOT_WRITABLE` naming `successor.proposedByActorId`, with the attempted
value going to the audit row and never to the response, exactly as every other
system-owned field is refused. The result carries four handles —
`successorVersionId`, `successorGateId`, `successorRunId`, `successorStepId` —
all four null together when no successor was asked for.

The settlement and the successor **commit together or not at all**: a handback
that opens a successor is one transaction, so a reader that sees the report
sees the pending gate, and a fault in either takes both with it.
`SUCCESSOR_OUT_OF_BOUNDS` 409 is the exception that settles **nothing** — the
lease is still live and the hold still held, so the caller may retry with a
successor that fits, or hand back without one. That is the opposite of the two
stale-fence refusals below, which do write their retained report. The runtime
side of the successor and the tests that hold it are in
[RUNTIME.md, "The successor is part of the settlement"](RUNTIME.md#the-successor-is-part-of-the-settlement).

**One refusal in this surface commits.** `LEASE_NOT_OWNED` and `LEASE_EXPIRED`
on `task.handback` are answered _after_ the runtime has written an append-only
`handback_reports` row with `disposition = 'retained'`: a stale holder's work
was still really done, and the refusal and the retained report are one fact.
Every other refusal rolls its handler's savepoint back; these two release it,
and the handler says which it is rather than a list of codes held somewhere
else. `ACTUAL_EXPENDITURE_UNSUPPORTED` is deliberately not one of them — it is
refused before the first write, so there is nothing to keep.

**A known gap, not a decision.** A `task.pickup` of a reservation whose lease
has expired should recover it into a fresh hold with a new `reservationId` and
`attemptId`. It does not: the second pickup mints a delegation for a purpose
the agent still holds live and faults on
`delegations_one_live_per_purpose_idx`, so the caller gets `500` with a
non-JSON body instead of any refusal, and the aborted transaction writes no
audit row for the attempt. `tests/api/task-runtime-routes.test.ts` records it
as an expected failure so that fixing it is loud.

`task.pickup` and `task.handback` refuse `AUTH_NO_AGENT_IDENTITY` 401 on the
person path. A pickup mints a delegation for an agent identity a person's
session does not have, and a body naming the agent to mint for would be a body
choosing whose authority is borrowed. Their entry point is the agent's own,
below.

**A payload naming a fact the server owns is refused** `FIELD_NOT_WRITABLE`
422, naming the keys, with nothing written (D06). `business_id`, `actor_id`,
`person_id`, `created_at`, `updated_at`, `revision`, `source`, `author` and
their camel-case spellings are all derived by the server, and the check is in
`prepareCommand`, which every command goes through. The attempted values go to
the audit event and never to the response.

## The support controls

The contract ledger requires revocation, cancellation with an authorised
restart, and the lease heartbeat through owning production interfaces, as
declared operations. These five rows are on `COMMAND_SURFACE`, so the person
prefix, the agent prefix, the command line and the parity tests reach them
with no hand list. None is a new actor power: each asks for authority the
caller already holds.

| Operation           | Route                | Body                                                        | Authority                                                                                                                                       | Refusals it can answer                                                                                                                                                |
| ------------------- | -------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grant.revoke`      | `/grant/revoke`      | `operationId`, `grantId`                                    | `manage` on tasks (the grant manager), then the manager's own ceiling: `manage` and the grant's own pair on its collection, at a covering scope | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `TRANSITION_NOT_PERMITTED` 409 (already revoked), `COMMAND_BODY_INVALID` 400                                                |
| `delegation.revoke` | `/delegation/revoke` | `operationId`, `delegationId`                               | as `grant.revoke`, over every (collection, action) the delegation reaches, at its purpose scope                                                 | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `DELEGATION_NOT_LIVE` 401 (already revoked, settled or expired), `COMMAND_BODY_INVALID` 400                                 |
| `task.cancel`       | `/task/cancel`       | `operationId`, `recordId`, `lineageId`, `reason`            | `write` on tasks, the work-control authority `task.propose` asks                                                                                | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `LINEAGE_NOT_ON_TASK` 409, `LINEAGE_TERMINAL` 409, `FIELD_VALUE_INVALID` 422, `COMMAND_BODY_INVALID` 400                    |
| `task.restart`      | `/task/restart`      | `operationId`, `recordId`, `lineageId`, `expiresInSeconds?` | `write` on tasks, plus `propose`'s own read and write checks                                                                                    | `SCOPE_NOT_GRANTED` 403, `NOT_FOUND` 404, `LINEAGE_NOT_ON_TASK` 409, `TRANSITION_NOT_PERMITTED` 409 (live, completed or already restarted), `FIELD_VALUE_INVALID` 422 |
| `task.heartbeat`    | `/task/heartbeat`    | `operationId`, `leaseId`, `fence`, `leaseSeconds?`          | the lease's holder, presenting the delegation minted with it; agent prefix only                                                                 | `AUTH_NO_AGENT_IDENTITY` 401 on the person path, `DELEGATION_NOT_LIVE` 401, `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `FIELD_VALUE_INVALID` 422                     |

What each one does:

- **Revocation** writes `revoked_at` and nothing else, and the envelope's
  applied audit row names the revoked row's id as its subject. Nothing is
  cached, so the next call on the same session re-evaluates and is refused. A
  read admitted before the revocation finishes in its own transaction. This
  is I10's endpoint half, in `tests/api/controls-revoke.test.ts` and the
  role-case matrix's case (f).
- **Cancellation** reaches `cancelAndClassify`. The lineage becomes
  `cancelled` with the reason as its terminal reason, the live lease is
  released, and the lineage's holds are classified. The answer is
  `{ lineageId, state: 'cancelled', reservations: [{ reservationId, state, released }] }`.
  A pickup afterwards is `RESERVATION_NOT_CLAIMABLE` 409, and the refusal is
  audited. A new version in the lineage is `LINEAGE_TERMINAL`.
- **Restart** takes no proposal of its own. It proposes the terminal lineage's
  last version again under a new lineage whose `restarts_lineage_id` names the
  old one. The answer is `{ lineageId, restartsLineageId, versionId, version: 1, gateId, payloadDigest }`.
  The new gate is pending, with no decision and no hold, and the old lineage,
  lease and hold are never reopened or reused (G05). A terminal lineage is
  restarted once.
- **Heartbeat** moves the lease's and its delegation's expiry to now plus
  `leaseSeconds` (1 to 3600, default 900). It is capped at 8 hours after the
  pickup and never shortens a lease. A stale fence or someone else's lease is
  `LEASE_NOT_OWNED`. A settled, revoked or expired delegation is
  `DELEGATION_NOT_LIVE`, and a lease past its instant is not revived. No timer
  runs. Bounded unstarted recovery stays with the owning operations'
  classifier ([RUNTIME.md](RUNTIME.md)).

### Source-to-route manifest

Every route is generated from `COMMAND_SURFACE` by the one loop on each
prefix (`apps/api/app.ts:148` person, `apps/api/app.ts:209` agent). The
command line derives its verbs from the same table (`apps/cli/client.ts:68`).

| Operation           | Person route                                         | Agent route                             | Declared                                            | Handler                                                                                       | Owning function                                                                                            |
| ------------------- | ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `grant.revoke`      | `/api/b/:key/grant/revoke`                           | refused `DELEGATION_EXCLUDES_OPERATION` | `packages/core-records/src/commands/surface.ts:249` | `commands/handlers.ts:98` → `commands/authority-controls.ts:88` `revokeGrantAsManager`        | `authority/grants.ts:244` `revokeGrant`                                                                    |
| `delegation.revoke` | `/api/b/:key/delegation/revoke`                      | refused `DELEGATION_EXCLUDES_OPERATION` | `surface.ts:250`                                    | `commands/handlers.ts:100` → `commands/authority-controls.ts:126` `revokeDelegationAsManager` | `authority/delegations.ts:387` `revokeDelegation`                                                          |
| `task.cancel`       | `/api/b/:key/task/cancel`                            | refused `DELEGATION_EXCLUDES_OPERATION` | `surface.ts:255`                                    | `commands/handlers.ts:102` → `commands/tasks-controls.ts:86` `cancelOnTask`                   | `core-runtime/src/recovery.ts:426` `cancelAndClassify`                                                     |
| `task.restart`      | `/api/b/:key/task/restart`                           | refused `DELEGATION_EXCLUDES_OPERATION` | `surface.ts:256`                                    | `commands/handlers.ts:104` → `commands/tasks-controls.ts:119` `restartOnTask`                 | `core-runtime/src/restart.ts:38` `restart` → `propose.ts:77` `propose` (`refuseRestart`, `propose.ts:282`) |
| `task.heartbeat`    | refused `AUTH_NO_AGENT_IDENTITY` (`handlers.ts:109`) | `/api/a/b/:key/task/heartbeat`          | `surface.ts:259`                                    | `commands/agent-envelope.ts:500` → `commands/tasks-controls.ts:156` `heartbeatLease`          | `core-runtime/src/heartbeat.ts:53` `heartbeat`                                                             |

## Proposal projection

`task.read` carries every proposal on the task under `proposals`, newest
lineage first. It is on the detail rather than behind a read of its own because
a page that showed the evidence and then fetched the version separately could
offer a decision on a version it never displayed, and the exact version is the
whole of what `decide` compares. One read, one answer, one `versionId` for the
button to carry.

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
  }[];
  reservations: {
    id; state; heldMinor; actualMinor; classifiedCause; leaseId;
    lease: { id; fence; state; expiresAt; holderActorId } | null;
    attempt: { id; state; dispatchMarker; observed } | null;
  }[];
}[]
```

Three things about the shape are load-bearing. `gate.expired` is the
**server's** answer, so a client with a skewed clock cannot disagree with the
gate about whether it may still be decided. The decision links are the stored
rows, hash and all, so a reader can check the chain rather than trust a summary
of it — nothing here recomputes a hash, because handing back a recomputed value
as though it were the stored one would make a tampered row invisible. And the
evidence pack is the renderer's output **as stored**, never re-rendered on
read: evidence that changed between the decision and the display is the one
thing a gate cannot survive.

The proposals go to every reader of the detail, internal or external. The
projection carries no comment body and no field value the catalogue classifies
— it carries the proposal's own payload, which is what the proposer put in it
and what the decision was about — so a reader who may see the task may see what
somebody proposed doing to it.

## The agent's own entry point

`POST /api/a/b/:businessKey` + the same generated paths. A second entry point,
not a second surface: `/api/a/b/alpha/task/pickup` is the agent asking and
`/api/b/alpha/task/pickup` is a person asking, and neither can be mistaken for
the other by a proxy, a log reader or the server.

`Authorization: Bearer <GoTrue access token>` says which **agent login** is
calling, and it resolves through `identity/agent-login.ts` rather than the
person path. A login is in `person_logins` or in `actor_logins`, never both, so
a person presenting themselves here is `AUTH_NO_AGENT_IDENTITY` 401 and an
agent presenting itself on the person path is `AUTH_NO_MEMBERSHIP` 403.

`X-Agent-Delegation: <credential>` carries the delegation `task.pickup`
returned. It is a header and not a body field for the same reason the bearer
token is: a credential in a body is a credential that gets logged with the
payload, stored in the register row and compared by a digest.

An agent login **confers nothing at all**. Before a pickup it may read
`task.queue` and call `task.pickup`; every other operation answers
`DELEGATION_NOT_LIVE` 401, which is also what an unknown, expired, revoked or
settled credential answers, deliberately — telling them apart tells a caller
holding a stolen credential which of those it is. After a pickup every call is
intersected with the delegation on the spot: the collection, the action, and a
`scope` that must be **exactly** the one task it was minted for.

| Answer                          | Status | When                                                                                      |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `AUTH_NO_AGENT_IDENTITY`        | 401    | the login is not an agent login in this business                                          |
| `AUTH_SESSION_EXPIRED`          | 401    | the bearer's signature verifies and its `exp` has passed                                  |
| `DELEGATION_NOT_LIVE`           | 401    | no credential, or none that answers to a live delegation                                  |
| `DELEGATION_OUT_OF_PURPOSE`     | 403    | a sibling task, a collection or an action the purpose does not carry                      |
| `DELEGATION_NARROWED`           | 403    | the purpose reaches the call and the person's live grants no longer cover it              |
| `DELEGATION_EXCLUDES_DECISION`  | 403    | `task.decide`, always, from L4's `decideAsAgent` asking L2                                |
| `DELEGATION_EXCLUDES_OPERATION` | 403    | an operation outside the queue, a pickup, its own task and a handback, and `task.comment` |
| `DELEGATION_ALREADY_LIVE`       | 409    | a pickup under a purpose word the agent already holds a live delegation for               |

Which of these a caller can meet on this head, where each is raised and which
tests hold it are in [AUTHORITY.md, "Refusal codes, as L3 registered
them"](AUTHORITY.md#refusal-codes-as-l3-registered-them). The runtime's own
codes are in [RUNTIME.md](RUNTIME.md#refusal-codes-as-l3-registered-them).

`AUTH_SESSION_EXPIRED` is answered on **both** paths. The rule above for
everything else stands — a missing, forged, unsigned or subject-less token all
answer `AUTH_UNKNOWN_LOGIN` — because those are guesses and an expired token is
not: its signature verifies against this deployment's own secret, so whoever
sent it held a credential this server issued a session for. They learn nothing
from being told it has run out that they could not already prove, and they gain
the difference between a door they can open and one they cannot.

An agent is never an internal reader. It is a delegate working one task, not a
member of the business, so `task.read` gives it `externalCommentProjection`'s
answer and an internal note is absent from it rather than hidden in it (I09).

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
A declared read with no executor refuses `DEPENDENCY_NOT_LANDED` rather than
`404`, which is the answer the surface already gives for a part not yet built.

`task.read` carries the task's comments. An internal reader — a membership
role of `owner`, `admin` or `member` — is given every comment in full; every
other role is given `externalCommentProjection`'s answer, which is the client
comments in the fields the catalogue marks `shared` (`id`, `audience`,
`author`, `body`, `comment_type`, `posted_at`). External is the default, so a
role nobody classified sees the client view rather than everything.

| Read                   | Route                   | Body                     | Answer                                                                                       | Refusals it can answer                                                         |
| ---------------------- | ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `settings.read`        | `/settings/read`        | `{}`; it takes no fields | `{ ok: true, settings: [{ key, value, valueType, revision, updatedAt, updatedByActorId }] }` | `SCOPE_NOT_GRANTED` 403, `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 401    |
| `session.capabilities` | `/session/capabilities` | `{}`; it takes no fields | `{ ok: true, personId, businessKey, grants: [{ collection, action }] }`                      | `FIELD_NOT_WRITABLE` 422, `AUTH_NO_MEMBERSHIP` 401, `AUTH_SESSION_EXPIRED` 401 |

`settings.read` takes **`read` on `settings`** while the two settings commands
take `manage` on the same collection. That asymmetry is the decision: a setting
is a business fact every member works against — a member who cannot see the
four-eyes band cannot tell a refusal from a bug when their own work stops at a
second approver — and changing one is an authority change. The seed gives
`settings:read` to `admin` and to `member`; the write stays with `admin`.

**`settings.read` carries a `revision` on every setting.** It is the number
migration 0020 gave `business_settings`, and it is the number the two settings
commands take back as `expectedRevision`, so a screen that read a value can
write it back against the version it actually saw. Alongside it the row still
carries `updatedAt` and `updatedByActorId`, which say when the value last
changed and which actor changed it — both null on a value nobody has written
since it shipped. A `revision` in a read a caller then writes against is the
whole of the optimistic check: there is no other watermark.

`session.capabilities` is the one read that **asks the grant model nothing**.
It reports what the caller already holds, so a grant in front of it could only
hide from a person the list of things they may do, and a caller refused it
could rebuild the same list by attempting each operation one at a time.
Membership is its whole authority and membership is established upstream: a
login that resolves to none is `AUTH_NO_MEMBERSHIP` before any read runs. The
grants are read live in the caller's own transaction through the same
`effectiveGrants` the authority check uses, so a grant revoked a moment ago is
missing from the answer rather than soon. It never carries a secret, and it
never carries another person's grants: the subjects are the session's own and
there is no parameter to point at somebody else.

On the **agent prefix** the same name answers the agent's own capabilities and
not the delegating person's: `agentActorId`, `businessKey`, the delegation's
`purposeScope` — `{ kind: 'record', id }`, or `null` before a pickup — and
`grants`, which is the authority the two pre-pickup operations take
(`task.queue` reads and `task.pickup` writes on `task`). It is reachable with
no credential on purpose: refusing it for want of one would refuse the single
call whose whole subject is that there is none.

**One shape on both prefixes.** Both answers are flattened beside `ok`, and
neither carries a `detail`. The subject fields differ because the subjects do,
and `businessKey` and `grants` sit at the same level on both:

| Prefix                     | Body on success                                                 | Code                                                          |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| person, `/api/b/:key/...`  | `{ ok: true, personId, businessKey, grants }`                   | `reads/dispatch.ts:210-213`                                   |
| agent, `/api/a/b/:key/...` | `{ ok: true, agentActorId, businessKey, purposeScope, grants }` | `commands/agent-envelope.ts:378-409`, flattened at `:162-167` |

The agent handler still stores the answer as the handle every agent command is
stored as, `{ recordId: null, revision: null, detail }`, so a replay reads the
same register row. `agentAnswer` flattens it at the wire (`apps/api/app.ts:241`),
for the first answer and a replay alike. Every other agent answer keeps its
payload under `detail`.

Two more things about the agent answer. Its `grants` is always the pre-pickup
pair, before and after a pickup; after a pickup only `purposeScope` changes. And
a credential that no longer answers to a live delegation gives `purposeScope:
null` rather than a refusal, so the answer does not say whether a credential was
sent. `tests/api/capabilities-shape.test.ts:34` asserts the one shape on both
prefixes and on a replay. `tests/acceptance/role-case-matrix.test.ts` case (h)
asserts it flattened with no `detail` (`:289-290`), `purposeScope` null before a
pickup (`:293`) and the picked-up task after it (`:372`); it records the agent
rows as named exceptions, not passes.

**A read payload naming a fact the server owns is refused**
`FIELD_NOT_WRITABLE` 422, naming the offending keys. It is the commands' own
rule, applied by `reads/dispatch.ts` from `prepare.ts`'s `SYSTEM_OWNED_FIELDS`
rather than from a second copy, so `actor_id`, `business_id`, `revision`,
`updated_at` and the rest are refused on a read exactly as they are on a write
(D06). This used to be a silent drop with a `200` on top, which is the weaker
answer the accepted ledger rules out: a client that believed it had set
`actor_id` got a success and no correction, so the mistake lived in the client
and the server looked fine. The **attempted values** go to the audit row's
`attempted` column and never to the response.

**Every read writes an audit event**, of the same shape the commands write,
successful and refused alike (I13). Its `operation_id` is null: a read has
nothing to replay. A read of one task carries that task as the subject, which
is what makes "who looked at this" answerable — and the task's own `history`
excludes the reads, because a history is what happened _to_ the task.
`settings.read` and `session.capabilities` carry a **null subject**: neither is
about one record, and naming one would make "who read this record" false.

## Verifying it

`node scripts/local/verify-slice.mjs` signs in through the local GoTrue with
the seeded passwords and walks create, start, complete, reopen and edit, then
the refusals: a foreign business writing a real and a fabricated id with their
bodies and timings compared, a login with no membership, a replayed operation
identity, a reused one, a stale revision, generic writes to protected fields, a
spoofed system field, and a body and headers carrying an actor and a business
that reach nothing. One line per case with the status and the code it observed;
a case that cannot run yet prints `unrun` with its reason.
