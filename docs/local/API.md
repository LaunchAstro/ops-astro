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

| Operation                          | Route                               | Body                                                                              | Refusals it can answer                                                                                                                                     |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.comment`                     | `/task/comment`                     | `operationId`, `recordId`, `expectedRevision`, `body`, `audience`, `commentType?` | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404, `VERSION_STALE` 409, `DEPENDENCY_NOT_LANDED` 501 where a business has no comment type |
| `preset.plan`                      | `/preset/plan`                      | `recordTypeKey`, `presetKey`, `fields[]`                                          | `SCOPE_NOT_GRANTED` 403, `PRESET_FIELD_UNCLASSIFIED` 422, `PRESET_TYPE_UNKNOWN` 404, `PRESET_FIELD_UNPLACEABLE` 409, `PRESET_FIELD_DUPLICATE` 422          |
| `settings.set_four_eyes_threshold` | `/settings/set_four_eyes_threshold` | `operationId`, `value` (number or `null`)                                         | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                        |
| `settings.set_client_sign_off`     | `/settings/set_client_sign_off`     | `operationId`, `value` (boolean)                                                  | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                        |

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

The two settings commands take no `expectedRevision`: `business_settings`
carries no revision column, so there is nothing for a caller to write against.
That is a schema gap rather than a decision and it is recorded as one.

## The operations L4's runtime made possible

`NOT_LANDED` is empty. Nothing in `COMMAND_SURFACE` answers
`DEPENDENCY_NOT_LANDED` because a part it rests on has not been built.

| Operation       | Route            | Body                                                                                                                                       | Refusals it can answer                                                                                                                                                                                                     |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.propose`  | `/task/propose`  | `operationId`, `recordId`, `expectedRevision`, `purpose`, `maximumMinor`, `currency`, `payload`, `step`, `expiresInSeconds?`, `lineageId?` | `SCOPE_NOT_GRANTED` 403, `PROPOSAL_OUT_OF_SCOPE` 403, `LINEAGE_TERMINAL` 409, `CHANGE_ROUNDS_EXHAUSTED` 409, `VERSION_STALE` 409, `NOT_FOUND` 404, `FIELD_VALUE_INVALID` 422                                               |
| `task.decide`   | `/task/decide`   | `operationId`, `gateId`, `versionId`, `decision`, `note`                                                                                   | `GATE_NOT_FOUND` 404, `GATE_ALREADY_DECIDED` 409, `GATE_EXPIRED` 410, `VERSION_SUPERSEDED` 409, `EVIDENCE_MISMATCH` 409, `LINEAGE_TERMINAL` 409, `BUDGET_UNAVAILABLE` 409, `BUDGET_EXHAUSTED` 402, `SCOPE_NOT_GRANTED` 403 |
| `task.pickup`   | `/task/pickup`   | `operationId`, `reservationId`, `leaseSeconds?`                                                                                            | `AUTH_NO_AGENT_IDENTITY` 401 on the person path, `RESERVATION_NOT_CLAIMABLE` 409, `DELEGATION_WIDENS` 403, `FIELD_VALUE_INVALID` 422                                                                                       |
| `task.handback` | `/task/handback` | `operationId`, `leaseId`, `fence`, `outcome`, `report?`                                                                                    | `AUTH_NO_AGENT_IDENTITY` 401 on the person path, `LEASE_NOT_OWNED` 403, `LEASE_EXPIRED` 410, `FIELD_VALUE_INVALID` 422                                                                                                     |
| `task.queue`    | `/task/queue`    | nothing; it is a read                                                                                                                      | `SCOPE_NOT_GRANTED` 403                                                                                                                                                                                                    |

`task.propose` writes a proposal beside the task and leaves the task's own
revision alone, so a caller may keep writing against the revision they hold.
The proposer, the subjects and the expiry instant are the server's: a body
naming an absolute `expiresAt` could raise a gate nobody can decide or hold a
ceiling open for a decade, and a duration the server adds to its own clock can
do neither.

`task.decide` names the **exact version** it is deciding. It is compared under
the locks and never trusted, so a decision made from a page that has gone stale
is `VERSION_SUPERSEDED` rather than a decision about something the decider
never read. The signing key and the budget cap are not in the body: the key
comes from the deployment's environment and the cap is the business's own,
read rather than created, because a command that created the ceiling it then
spent against could never be refused `BUDGET_EXHAUSTED`.

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

| Answer                          | Status | When                                                                         |
| ------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `AUTH_NO_AGENT_IDENTITY`        | 401    | the login is not an agent login in this business                             |
| `AUTH_SESSION_EXPIRED`          | 401    | the bearer's signature verifies and its `exp` has passed                     |
| `DELEGATION_NOT_LIVE`           | 401    | no credential, or none that answers to a live delegation                     |
| `DELEGATION_OUT_OF_PURPOSE`     | 403    | a sibling task, a collection or an action the purpose does not carry         |
| `DELEGATION_NARROWED`           | 403    | the purpose reaches the call and the person's live grants no longer cover it |
| `DELEGATION_EXCLUDES_DECISION`  | 403    | `task.decide`, always, from L4's `decideAsAgent` asking L2                   |
| `DELEGATION_EXCLUDES_OPERATION` | 403    | an operation outside the queue, a pickup, its own task and a handback        |

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

`task.read`, `task.board`, `person.list` and `preset.plan` are declared in
`COMMAND_SURFACE` with `kind: 'read'`. The boundary branches on that and calls
the executor the composition root supplies:

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

**Every read writes an audit event**, of the same shape the commands write,
successful and refused alike (I13). Its `operation_id` is null: a read has
nothing to replay. A read of one task carries that task as the subject, which
is what makes "who looked at this" answerable — and the task's own `history`
excludes the reads, because a history is what happened _to_ the task.

## Verifying it

`node scripts/local/verify-slice.mjs` signs in through the local GoTrue with
the seeded passwords and walks create, start, complete, reopen and edit, then
the refusals: a foreign business writing a real and a fabricated id with their
bodies and timings compared, a login with no membership, a replayed operation
identity, a reused one, a stale revision, generic writes to protected fields, a
spoofed system field, and a body and headers carrying an actor and a business
that reach nothing. One line per case with the status and the code it observed;
a case that cannot run yet prints `unrun` with its reason.
