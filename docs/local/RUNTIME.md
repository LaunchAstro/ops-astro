<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The bounded runtime, as lane L4 built it

Propose, decide, pick up, hand back, and the one classifier that closes work
nobody can claim any more. The authority half is [AUTHORITY.md](AUTHORITY.md)
and the data half is [DATA.md](DATA.md); this file is what happens between a
person deciding and a hold being released.

Nothing here is a plan. Every mechanism below is implemented in the tree and
tested by the cases named beside it, and [what is not here](#what-is-not-here)
says what is not. Implemented and tested is not reviewed or accepted. An
independent review of the runtime left findings that are still open, and the
review record lives with the build run's evidence rather than in this
repository. Until those findings are closed and the integrated head is reviewed
and accepted, read "proved" below as "a test asserts it", not as "done".

## The shape of it

Five transactions, in the order the accepted transaction contract names them.

| Boundary | Module        | What commits together                                                                |
| -------- | ------------- | ------------------------------------------------------------------------------------ |
| T1       | `propose.ts`  | version, planned run, step, rendered evidence pack, pending gate                     |
| T2       | `decide.ts`   | signed decision and chain link, envelope, reservation, immutable attempt, held total |
| T3       | `pickup.ts`   | delegation, fenced lease, reservation bound once, attempt dispatched                 |
| T4       | `handback.ts` | lease released, delegation settled, attempt outcome, reservation's disposition       |
| T5       | `recovery.ts` | the bounded classifier: `held` → `abandoned`, hold subtracted once, cause recorded   |

Nothing in this head dispatches. `planned_steps.dispatched_at` carries a check
constraint keeping it null, the attempt names no provider or model, and
`pickup` returns its `declaredIncompleteness` in the payload rather than
leaving a caller to discover it.

A gate is bound to its version, not only to its business, since migration
0021 (`migrations/0021_runtime_gate_version_binding.sql:38-56`). Three
composite foreign keys hold it: the gate's run plans the gate's version
(`gates_run_in_same_version`), its step is a step of that run
(`gates_step_in_same_run`), and its version is a version of its lineage
(`gates_version_in_same_lineage`). A gate pointed at another version's run or
step cannot be written, so it cannot be decided (ledger G01).

## The one rule the whole thing rests on

**Discover, lock, re-read, then write.** The lock order is the contract's — cap,
envelope, task, run, step, lineage, gate, lease, delegation, reservation,
operation — with one class in front of it, and it is in `locks.ts` as code
rather than in four handlers as prose. `acquire` takes the whole set, sorts it
by class and by key inside a class, and issues the statements in that order, so
a handler that lists a lease before a cap still takes the cap first.

The class in front is `chain`, the business's decision chain (R10,
`locks.ts:26-45`). It has no row, so it is a transaction-scoped advisory lock
(`:105-110`). `task.decide` takes it before the cap (`decide.ts:189`), so a
second approval racing in the same business waits on the chain lock, not on the
cap row.

`task.propose` takes cap, envelope, task, lineage, then the superseded
version's holds, live lease and delegation, in one ordered call
(`propose.ts:107-176`). It is declared `targetLock: 'runtime'`
(`commands/surface.ts:224`), so the command envelope only reads the task and
does not lock it (`commands/prepare.ts:337-345`). The expected revision is
compared once the runtime's locks are held (`commands/tasks-runtime.ts:202-209`).

Grants stay outside that order. `task.pickup` share-locks the grant chain
behind the claim's authority before it acquires the runtime set: the
claimant's own grants in the collection and every grant they descend from
(`holdCoveringGrants`, `pickup.ts:226-250`, called at `:304`). That mirrors
`grant.revoke`, which takes `for update` on the revoked grant before any
runtime lock (`commands/authority-controls.ts:221-222`). A revocation that
locks first is seen by the pickup's authority read, and one that locks second
waits for the pickup to commit and then finds its lease. Neither side waits on
a grant while it holds runtime locks.

The proof that this matters is concrete. `decide.ts` originally opened the
task's envelope **before** acquiring its locks, which is a write before the
lock set. Two approvals racing one task both found no envelope, both inserted,
and the loser met `duplicate key value violates unique constraint
"task_envelopes_task_open_idx"` instead of the typed `GATE_ALREADY_DECIDED` it
had earned. The gate race proof caught it; envelope creation now happens under
the locks, and the discovery pass before them only reads.

## The interfaces L3 consumes

Import from `packages/core-runtime/src/index.ts`, which is the pinned surface.

```ts
propose(tx, ProposeRequest): Promise<RuntimeResult<Proposal>>
decide(tx, DecideRequest): Promise<RuntimeResult<Decided>>
decideAsAgent(tx, Delegation, { collection, taskId }): Promise<RuntimeResult<never>>
queue(tx): Promise<readonly QueueEntry[]>
pickup(tx, PickupRequest): Promise<RuntimeResult<PickedUp>>
handback(tx, HandbackRequest): Promise<RuntimeResult<HandedBack>>
cancelAndClassify(tx, { lineageId, reason }): Promise<RuntimeResult<readonly Classification[]>>
restart(tx, RestartRequest): Promise<RuntimeResult<Restarted>>
heartbeat(tx, HeartbeatRequest): Promise<RuntimeResult<Renewed>>
replayRecordedTransitions(tx): Promise<readonly Classification[]>
classifyUnderLocks(tx, ClassifyRequest): Promise<Classification>
```

```ts
interface ProposeRequest {
  taskId: string;
  collection: string;
  proposedByActorId: string;
  subjects: readonly Subject[];
  purpose: string; // the slug shape `delegations.purpose` carries
  maximumMinor: number; // finite, positive, in minor units
  currency: string;
  payload: Record<string, unknown>;
  step: { kind: string; payload: Record<string, unknown> };
  expiresAt: Date;
  lineageId?: string; // absent opens a lineage; present adds a version
}
interface Proposal {
  lineageId;
  versionId;
  version: number;
  runId;
  stepId;
  evidencePackId;
  gateId;
  payloadDigest: string;
}

interface DecideRequest {
  gateId;
  versionId; // the exact version, compared and never trusted
  decidedByPersonId;
  decidedByActorId;
  subjects;
  collection;
  decision: 'approve' | 'reject' | 'request_changes';
  note: string;
  signingKey: SigningKey;
  capId: string;
}
interface Decided {
  decisionId;
  gateId;
  versionId;
  decision;
  hash: string;
  envelopeId?;
  reservationId?;
  attemptId?;
  heldMinor?; // an approval only
}

interface PickupRequest {
  reservationId;
  agentActorId;
  authorisedByPersonId; // the delegating person, named by the authorisation
  mintedByActorId; // their acting identity, never the agent's
  collection: string;
  leaseSeconds: number;
}
interface PickedUp {
  leaseId;
  fence: number;
  delegation: MintedDelegation;
  reservationId;
  attemptId;
  taskId;
  runId;
  versionId;
  expiresAt: Date;
  declaredIncompleteness: readonly string[];
}

interface SuccessorRequest {
  proposedByActorId; // whose authority the caller checked, not this package
  purpose: string;
  maximumMinor: number; // inside the cap behind the envelope
  currency: string; // the currency that envelope holds
  payload: Record<string, unknown>;
  step: { kind: string; payload: Record<string, unknown> };
  expiresAt: Date;
}

interface HandbackRequest {
  leaseId;
  fence: number; // the fence it believes it owns
  outcome: 'completed' | 'failed';
  report: Record<string, unknown>;
  actualMinor: number | null; // null is this head's honest answer
  successor?: SuccessorRequest; // optional: absent settles and proposes nothing
}
interface HandedBack {
  leaseId;
  reportId; // the durable report this handback stored
  reservationId;
  attemptId;
  reservationState: 'actual' | 'abandoned' | 'held' | 'quarantined';
  classification: Classification | null;
  envelopeHeldMinor: number;
  envelopeActualMinor: number;
  successorVersionId: string | null; // all four null when none was asked for
  successorGateId: string | null;
  successorRunId: string | null;
  successorStepId: string | null;
}
```

**The operands on the command surface.** On `task.pickup` and
`task.heartbeat`, for a person and an agent alike, a present `leaseSeconds`
must be a whole number of seconds from 1 to 3600. `null`, a fraction or
anything else is `FIELD_VALUE_INVALID` 422. Leaving it out gives 15 minutes,
for a pickup and a renewal alike (`readLeaseSeconds`,
`commands/tasks-runtime.ts:902-925`; defaults at `:339` and `:893`). A present
handback `report` must be an object: `null`, an array or a string is
`FIELD_VALUE_INVALID` (`:656-671`, on both prefixes). The pickup's brief lists
`excludedOperations` as `{ operation, reason }` pairs (`exclusionsFor`,
`:470-490`).

### Refusal codes, as L3 registered them

`RuntimeRefusalCode` is exported as this package's own type and is deliberately
**not** added to `commands/register.ts`, which is L3's file, for the reason
AUTHORITY.md gives: a module reaching into the command surface to add its own
codes is the coupling the register exists to prevent. `SUGGESTED_STATUS` in
`refusals.ts` carries the same table in code. L3 has registered every code
below at the status suggested here (`apps/api/status.ts`), and
`fromRuntime` (`commands/tasks-runtime.ts:72`) carries a runtime refusal onto
the command surface unchanged. Each operation's refusals, with their routes,
are in [API.md](API.md#the-operations-l4s-runtime-made-possible).

| Code                             | Status | Caller-visible                                                  |
| -------------------------------- | ------ | --------------------------------------------------------------- |
| `VERSION_SUPERSEDED`             | 409    | yes — re-read and decide the live version                       |
| `EVIDENCE_MISMATCH`              | 409    | yes                                                             |
| `GATE_NOT_FOUND`                 | 404    | yes                                                             |
| `GATE_ALREADY_DECIDED`           | 409    | yes — the loser of a decision race                              |
| `GATE_EXPIRED`                   | 410    | yes                                                             |
| `LINEAGE_TERMINAL`               | 409    | yes                                                             |
| `CHANGE_ROUNDS_EXHAUSTED`        | 409    | yes                                                             |
| `BUDGET_UNAVAILABLE`             | 409    | yes — this envelope has no room                                 |
| `BUDGET_EXHAUSTED`               | 402    | yes — the cap behind it has none                                |
| `PROPOSAL_OUT_OF_SCOPE`          | 403    | yes                                                             |
| `LINEAGE_NOT_ON_TASK`            | 409    | yes — the lineage is another task's                             |
| `CAP_BINDING_MISMATCH`           | 409    | yes — the envelope's cap is the cap                             |
| `ACTUAL_EXPENDITURE_UNSUPPORTED` | 422    | yes — this head observed no spending                            |
| `SUCCESSOR_OUT_OF_BOUNDS`        | 409    | yes — cap, currency or rounds                                   |
| `RESERVATION_NOT_CLAIMABLE`      | 409    | yes — one answer for none, unapproved and already picked up     |
| `LEASE_HELD`                     | 409    | yes — two held reservations on one task                         |
| `LEASE_NOT_OWNED`                | 403    | yes — a stale or foreign fence                                  |
| `LEASE_EXPIRED`                  | 410    | yes                                                             |
| `SCOPE_NOT_GRANTED`              | 403    | yes                                                             |
| `TRANSITION_NOT_PERMITTED`       | 409    | yes — restart of a live, completed or already restarted lineage |

`decideAsAgent` returns L2's `DELEGATION_EXCLUDES_DECISION`, which L3 registered
from AUTHORITY.md's table. It is not re-derived here.

`RESERVATION_NOT_CLAIMABLE` gives the same two sentences whether the
reservation does not exist, has no approval behind it, or is already picked up
by another live lease (`NOT_CLAIMABLE_REASON`, `pickup.ts:187-197`;
`commands/tasks-runtime.ts:435`, `:446`). The holding lease is never named.

`LEASE_HELD` is reachable. Two lineages approved on one task, under an
envelope an earlier handback left open, give two held reservations, and the
second pickup meets the first one's live lease (`commands/register.ts:421-427`,
`tests/commands/lease-held-reach.test.ts`). Its reason still names the task
(`pickup.ts:479-483`).

`LEASE_NOT_OWNED` for a lease the caller does not hold, on heartbeat and
handback, is a constant that echoes neither the presented lease nor the fence
(`heartbeat.ts:80-87`, `handback.ts:144-150`, `:213-218`). A stale or
superseded fence on a lease the caller does hold still names the lease and the
fences (`handback.ts:266-280`). `DELEGATION_OUT_OF_PURPOSE` for a call on
another resource names the delegation's own scope and not the presented one
(`authority/delegations.ts:405-414`).

## Why the money is two columns

`task_envelopes` carries `held_minor` and `actual_minor` separately, and the
reservation's terminal state is **`abandoned`, never a zero `actual`.** A
released hold that wrote `actual_minor = 0` would be a claim that the work ran
and cost nothing. Nothing in this head runs, so that claim would be an
invention, and the schema refuses it: `reservations_actual_only_when_actual`
makes carrying a number and being `actual` the same fact.

`BUDGET_UNAVAILABLE` and `BUDGET_EXHAUSTED` are separate because a caller told
the wrong one raises the wrong ceiling. The first is the task's envelope, the
second is the cap behind it.

## Why a lapsed gate reads expired but stays pending

Nathan decided this on 23 September 2026: show expired on read, and preserve
the stored record. Nothing writes `expired` to `gates.state`. There is no timer
and no migration, and no historical row is rewritten. A gate that passes its
deadline undecided stays stored as `pending`.

- **Decide refuses.** `decide` refuses it `GATE_EXPIRED` 410 and writes no
  decision (G06, `core-runtime/src/decide.ts`).
- **Reads project it.** `task.read` derives `state: 'expired'` and
  `expired: true` in the proposals read
  (`core-records/src/reads/proposals.ts`). The page therefore sees the same
  answer the refusal gives.
- **Both use the database clock.** Each side reads `now()` inside its own
  statement, never the application's clock.
- **The boundary is inclusive.** `expires_at <= now()` is expired on both
  sides, so at the deadline instant the read says expired and the decide
  refuses.
- **Only an otherwise pending gate expires.** An approved, rejected,
  changes-requested or superseded gate reads its stored outcome after its
  deadline.

The cases are `tests/reads/gate-expiry.test.ts`, which crosses the deadline
on the database clock through the production propose path, and
`tests/surfaces/proposal-expired.test.tsx`.

The deadline itself has a ceiling, the second owner decision of 23 September
2026: `expiresInSeconds` is at most 604800, seven days, on `task.propose`, on
the handback successor and on `task.restart`, all through one `expiryFrom`.
Over it is `FIELD_VALUE_INVALID` 422 and nothing is written
(`tests/api/expiry-bound.test.ts`; the inputs are in
[API.md](API.md#the-operations-l4s-runtime-made-possible)).

## A decision is verified before a read returns it

`task.read` verifies every decision it returns before it answers
(`core-records/src/reads/verified-decisions.ts`, called from `proposals.ts:255`).
It walks the business's decision chain from genesis to the newest decision the
read returns. For each row it recomputes the payload digest from the stored
JSON, then checks the signature and the link hash with the deployment's key,
`GATE_SIGNING_KEY_ID` and `GATE_SIGNING_SECRET` (`signing.ts:78-114`). A
decision that does not verify fails the read. So do stored decisions when no
key is configured. The failure is `DecisionIntegrityError`, code
`DECISION_INTEGRITY` (`verified-decisions.ts:44-51`). Over HTTP it is a fault,
5xx with no task in the body, not a refusal. Verifying writes nothing: the
stored rows are left as they were found. `tests/reads/verified-decisions.test.ts`
tampers as the database owner and asserts each failure, and that a clean read
changes nothing.

The chain and the gate and lineage facts it is checked against are read in one
statement, so they are one snapshot (`readSnapshot`, `verified-decisions.ts:322`).
The read runs read-committed, where each statement sees what was committed when
it began. A chain read before a `task.decide` commits and a gate read after it
would find an approved gate with no decision and fault on intact evidence. One
statement answers the old view or the new one. Nothing else changes isolation
or takes a lock. `tests/reads/decision-snapshot.test.ts` pauses the read after
each statement, commits a real `task.decide` on another connection, and checks
that the read answers without `DECISION_INTEGRITY`. It covers the first decision
on a pending gate, a later decision on a lineage that already has one, and the
proposal projection. A genuinely missing decision still fails the same read.

Its limits:

- The link covers the decision's id, sequence, gate, version, decision,
  deciding person, payload digest and signature (`verified-decisions.ts:146-157`).
  It does not cover `round`, `decided_at`, the acting identity or the evidence
  digest, so those read as stored.
- Removing the newest decision is not caught by the chain. The walk ends at
  the newest decision still stored, and nothing it reads links to the removed
  one.
- There is one signing key. A row signed under an earlier key id fails the
  read (`signing.ts:99-100`).

## Why the lease is fenced

The fence is the identity of the claim, not of the task, and it is monotonic per
task under the task lock. A holder whose lease was replaced presents the old
fence and nothing changes: `LEASE_NOT_OWNED` on a superseded or mismatched
fence, `LEASE_EXPIRED` when the lease itself is over. Its report can be retained
separately; it cannot settle the replacement's work.

A handback names a lease, not a task. The agent envelope reads the task from
the lease before the delegation check (`subjectTaskId`, `commands/agent-envelope.ts:418-446`), so
a handback naming a lease on another task is outside the one-task purpose and
is refused `DELEGATION_OUT_OF_PURPOSE` before any handback write (matrix case
(i), `tests/acceptance/role-case-matrix.test.ts:430-449`). `LEASE_NOT_OWNED`
stays the answer for a stale fence on the agent's own task.

**Superseded work cannot settle.** Proposing a new version retires the
superseded version's live lease and delegation in the same ordered lock set:
the lease is released and the delegation revoked (`propose.ts:150-176`, `:280`;
`recovery.ts:368-386`). Under its full lock set, `handback` then checks that
the lease still binds a live version on a live lineage. If the version was
superseded, or the lineage is no longer live, it keeps the report as
`retained`, refuses `LEASE_NOT_OWNED` naming the cause, and settles nothing
(`handback.ts:244-287`). `tests/runtime/lifecycle-stale-handback.test.ts` holds
four cases, with and without a successor.

**A retired agent's late report is still kept** (T4 lines 76 and 78, runtime
review C2). Supersession, cancellation, settlement and plain expiry leave the original agent's credential answering to no live delegation,
so the agent entry refuses its new handback `DELEGATION_NOT_LIVE` before
`handback` is reached. A delegation revoked for authority loss answers
`DELEGATION_NARROWED` and keeps nothing, as R-B holds. The refusal stands, and
the report is kept by an evidence-only intake (`retainLateHandback`,
`commands/agent-envelope.ts:685`): the credential must name a delegation of this
business and this authenticated agent that is no longer live
(`resolveHistoricalDelegation`, `authority/delegations.ts:377`), and the
presented lease and fence must be that delegation's exactly
(`retainHistoricalReport`, `handback.ts:518`). Then one `retained` row naming
the refusal is appended, beside the refused audit row. No lease, delegation,
run, attempt, reservation, gate, envelope or successor is written, and nothing
is read back to the caller. A wrong lease, fence or credential, another
agent's credential and any other refusal retain nothing. A settled handback's
replay is still answered from its register row; only a new operation id is a
new late report. `tests/runtime/historical-handback-intake.test.ts` holds it
over HTTP.

**An abandoned hold is replaced, never revived** (R5). At pickup, a hold that
ended without settling, because its lease expired or the authority behind it
was lost, on a version still approved and current on a live lineage, is
replaced by a fresh hold and a fresh attempt on that version, under the locks
the pickup already holds (`pickup.ts:392-452`). The abandoned reservation stays
abandoned. A settled hold, a quarantined one, or a version already holding
elsewhere is refused `RESERVATION_NOT_CLAIMABLE` (`:369-375`, `replaceable` at
`:615-630`).

The delegation expires **with** the lease — `pickup` passes the lease expiry as
`expiresAt` — because a delegation outliving its lease is an agent still holding
narrowed authority over work somebody else now owns.

## The successor is part of the settlement

T4: "where approval is required, create the successor proposal/run/step/evidence
pack and pending gate in this same transaction through a lock-aware production
proposal writer", and "a fault rolls back work settlement, accounting release,
successor creation and the success receipt together". Both halves are built.

The writer is `packages/core-runtime/src/proposal-writer.ts`. It holds the
version, run, step, evidence-pack and gate writes once, and `propose` and
`handback` both go through it, so the head has one proposal writer rather than
two that drift. It takes the caller's `LockSet` and opens no transaction: it
calls `LockSet.require` for the task, the lineage and — when the task already
has them — the cap and the envelope a later decision will bind the version to,
and throws if any is missing. That is the contract's "helpers receive the
already-held lock context" as an argument rather than a comment, and it is why
`handback` can create a successor without the thing T4 forbids: it never calls
`propose`, which would check the wrong actor's authority and open a lock set of
its own part-way through a transaction that already holds the lease.

`propose` preallocates the identity of a lineage it is about to open **before**
it acquires, so the whole set is one ordered call and the lineage lock is never
taken after the reservation locks. T4 calls that "identity preparation, not a
write or approval".

`handback`'s successor input is optional and bounded. Absent is the ordinary
handback, which settles and proposes nothing. Present is refused
`SUCCESSOR_OUT_OF_BOUNDS`, before the first write, unless the ceiling is finite
and positive, fits the room left in the cap behind the envelope, is denominated
in that envelope's currency, and would not be the lineage's third formal round
(G08). The successor is created **after** the classification, which is the order
the facts come in: the classification is what makes the old attempt
nonclaimable, and the successor is the work somebody may now approve instead. It
is not approved and it opens no hold. A stale fence never reaches it — those
paths retain their report and return — so a lease that cannot settle work
cannot propose the next of it either.

**On the command surface.** L3 carries the successor through `task.handback`
(`commands/tasks-runtime.ts`, `readSuccessor` at `:563`). The body's
`successor` is read and checked before the runtime is reached, and
`proposedByActorId` is not a body field: the agent actor of the session
proposes it (`:653`). A body that names it under either spelling is refused
`FIELD_NOT_WRITABLE` (`:530`). `expiresAt` is optional there and defaults to
the same week `task.propose` uses. The result carries the four successor
handles, all null when none was asked for. The body and the refusals are in
[API.md](API.md#the-operations-l4s-runtime-made-possible).
`tests/commands/handback-successor.test.ts` holds the reading of the body with
no database, and the `task.handback and its successor` block in
`tests/api/task-runtime-routes.test.ts` (`:574`) holds it over HTTP. That block
covers no successor, an in-bounds successor committed with the settlement, a
body naming the actor, and `SUCCESSOR_OUT_OF_BOUNDS` settling nothing.

One seam is open. `SuccessorRequest` pins an absolute `expiresAt`, while
`task.propose` takes `expiresInSeconds` and computes the instant on the server.
The surface refuses a past or malformed instant, so neither of the failures
`task.propose`'s duration guards against can be reached. There are still two
spellings for one concept.

## What the classifier will not do

`recovery.ts` closes the lifecycle of work that is durably no longer claimable.
It is invoked from inside the authorised operations that write those
transitions, and `classifyUnderLocks` takes no lock of its own because its
caller holds the complete set already.

The cause a caller names is revalidated against the durable rows under the
locks before anything is released: a lineage that is not cancelled does not
support `lineage_cancelled`, and a live lease does not support
`lease_expired_and_fenced`. The release itself is a guarded update that
reports the row it changed, and the envelope subtraction uses that row's own
amount, so a classifier that lost the race writes nothing.

Startup, elapsed time, a missing claimant and `lease_id = null` are **not**
abandonment triggers. An approved, unleased, currently authorised reservation
stays held across a restart and stays pickupable; the restart proof asserts
exactly that, and then asserts that `replayRecordedTransitions` run on that
restart returns an empty list. Only after a recorded terminal transition does
the same call release it, once, with the cause and the cause's identity on the
row.

A `dispatch_marker` or an `observed` attempt always keeps its **full hold**, as
`quarantined`, even when the work is otherwise terminal — and 0014's trigger
refuses to let either flag be lowered. Work refusal must never erase a real
liability.

### Restart recovery at API startup

TRANSACTION-CONTRACT lines 84 and 92: a first-head restart resumes the same
bounded classifier. **An API process start or restart is the resume entry.**
`apps/api/server.ts` awaits `recoverInstallation` (`apps/api/recovery-entry.ts`)
after its dependencies are validated and before `serve` binds the port. There
is no database-only reconnect callback: if Postgres restarts under a running
API, the replay runs at the API's next start, and nothing polls.

- **Scope.** `RECOVERY_BUSINESS_KEYS`, from the environment or
  `.local/recovery.env`: comma-separated business keys, de-duplicated, each
  resolved on its own through `createBusinessResolver`, or the literal `none`.
  Unset, blank, an empty entry, `none` beside a key, or a key that resolves to
  no business stops the start with exit 1 and names the setting, before any
  replay. No request, seed, fixture or scan of `public.businesses` supplies the
  set; the administrative connection runs only the key lookups.
- **One transaction per business.** Each business runs
  `database.withBusiness(id, tx => replayRecordedTransitions(tx))` as the
  application role, with the tenant set by `set_config(..., true)` inside that
  transaction, one business after another.
- **Failure.** A failed replay, including the classifier's refusal when
  discovery changed under its locks (`recovery.ts:443-449`), rolls that
  business back and exits 1 with `restart recovery for business "<key>" rolled
back: <reason>`. There is no automatic retry: the next normal start runs the
  replay again in a fresh transaction. A business that committed before the
  failure stays committed and has nothing left to replay.
- **Record.** After each commit the server logs `restart recovery: <key>
committed, <n> classified, <r> released, <q> quarantined`. The durable record
  is the classifier's own: `classified_cause` and `classified_cause_id` on the
  reservation, naming the transition another operation recorded. Startup
  invents no person or agent and creates no cancellation, approval, lease,
  attempt, delegation, dispatch mark or spend.

`tests/runtime/recovery-entry.test.ts` proves this through the real
`apps/api/server.ts` process: classification once before readiness, a second
start that subtracts nothing, a failed start that rolls back and a later one
that completes, claimable and unfenced-live holds untouched, a marked hold kept
whole, only the configured business changed, and two racing starts releasing
each hold once (one completes; the other exits 1 on the changed discovery).

## The proofs

`tests/runtime/gate.test.ts`, `tests/runtime/lease.test.ts`,
`tests/runtime/review-fixes.test.ts`, `tests/runtime/classifier-race.test.ts`
and `tests/runtime/decision-abort.test.ts`, 39 cases, all against a real
Postgres migrated from empty.

**What these cases are and are not.** Each one below states what its own
assertions cover, and nothing here is a claim beyond them. They are executed
source regressions on a local database: they are not a runtime security
certification, not an executed proof of the full 42 obligations, and not
evidence about a restarted browser, API or Postgres process. Where a case
establishes one direction of an obligation, the obligation is named as
partly covered rather than proved.

- The race is **forced, not hoped for**: the first transaction is held open on a
  barrier and the second is watched into `wait_event_type = 'Lock'` in
  `pg_stat_activity` before the barrier releases. A run that cannot establish
  the interleaving throws rather than passing quietly. It needs a second
  physical connection, because the fixture's pool is `max: 1` and on one handle
  the second caller queues on the _pool_ and never reaches the gate row.
- The stale fence is asserted **twice**: the refusal carries the right code, and
  a full snapshot of every reservation, attempt, lease and envelope is compared
  before and after. A refusal that still released a hold passes the first
  assertion and fails the second.
- **Two formal rounds, and no third** (G08): each round is a real
  `request_changes` decision and a real new version, the superseded version's
  gate refuses an approval across the round boundary (G04 holding across
  rounds), and the third round is refused `CHANGE_ROUNDS_EXHAUSTED` with no
  decision row written. The lineage stays live, so approving or rejecting is
  still open — the cap bounds rounds, not the decision.
- **Rejection is terminal** (G05): the rejected gate takes no second decision,
  a new version in the same lineage is refused `LINEAGE_TERMINAL` on the
  lineage rather than on the gate, and the authorised restart is a new lineage
  with a new version and a new pending gate beside the rejected one, never
  over it.
- **The cap's refusal is the cap's** (W05): an approval larger than the cap but
  smaller than its envelope is refused `BUDGET_EXHAUSTED`, not
  `BUDGET_UNAVAILABLE`, and no total moves.
- **The interruption, both ways** (W01): the same production `propose` and
  `decide` calls followed by a throw at the transaction boundary leave a fresh
  connection zero decisions, envelopes, reservations and attempts; committed,
  the same fresh-connection read finds all four and `replayRecordedTransitions`
  has nothing to do.
- **`acquire` sorts, and that is what is observed**: two transactions each list
  cap, envelope and gate in an order the contract forbids, and in different
  wrong orders. `pg_locks` is asked which table the blocked one is parked on,
  and the answer is `budget_caps` — the class `acquire` reached first —
  although it listed the envelope first. With the sort removed from `acquire`
  the same case reports `task_envelopes`, which is the crossing that deadlocks.
  This covers `acquire` in isolation. It does not establish that every handler
  passes `acquire` its complete set, which is a separate property: the
  dcbc8e8 review found recovery bypassing it entirely, and the case below is
  what now holds that half.
- **The classifier asserts its caller's locks** (R1): `classifyUnderLocks`
  takes a required `LockSet` and calls `LockSet.require` for the reservation
  and for the envelope whose total it is about to move. A caller holding only
  the task lock throws rather than releasing a hold. This makes "helpers
  receive the already-held lock context" a runtime fact for this helper.
- **The two-classifier race, executed** (R1), in
  `tests/runtime/classifier-race.test.ts`: two backends classify one
  reservation concurrently through `classifyUnderLocks`, each holding the
  complete set through `acquire`, and the second is watched into
  `wait_event_type = 'Lock'` in `pg_stat_activity` before the first commits, so
  the interleaving is observed rather than slept through. Exactly one reports
  `released: true`; the loser reports `released: false` and says another
  transaction classified it first; the envelope's held total falls by the
  hold's amount exactly once and its actual total does not move. This is the
  schedule the earlier structural case could not establish, and it is what the
  dcbc8e8 review's "two classifiers can both read `held`" asked for.
- **The envelope's cap is the cap** (R2): a decision naming a cap the task's
  existing envelope does not draw on is refused `CAP_BINDING_MISMATCH`, and
  the case reads back that no decision row was written and the gate is still
  pending. This covers the binding.
- **The post-write reservation refusal aborts, executed** (R2), in
  `tests/runtime/decision-abort.test.ts`: an owner-installed trigger shrinks
  the envelope this approval opens, below the hold it is about to take, so
  `decide`'s preflight passes on the cap alone, the signed decision row and the
  approved gate are written, and `reserve` then refuses `BUDGET_UNAVAILABLE`
  under the same locks. The call **throws**, and a new transaction reads back
  zero decision rows, a still-pending gate, no reservation, no attempt, no
  envelope for that task and unchanged business totals. The trigger rewrites a
  value rather than raising on purpose: a trigger that raised would abort the
  transaction by itself and would prove nothing about what `decide` does with a
  refusal it was handed. With the trigger dropped the same gate approves, which
  is what makes the abort an abort rather than an unapprovable fixture.
- **A lineage belongs to one task** (R3): the refusal is asserted, the other
  task's version is read back unsuperseded, and 0017's composite foreign key is
  asserted separately by moving a run onto another task.
- **Supersession and rejection release their own holds** (R8): the superseded
  reservation is read back `abandoned` with `version_superseded` as its cause
  and the envelope's held total back to zero, in the transaction that
  superseded it and with no replay call.
- **The decision chain is allocated under a lock** (R10): two approvals on
  different tasks and different caps of one business run concurrently and both
  commit with consecutive sequences. This case is what found the chain head
  being read with `order by seq desc` against a text alias, which reused a
  sequence from the tenth decision on.
- **The report is durable** (R4): the settled report is read back by the
  identity the result returned, and a stale fence's report is read back as
  `retained` with the refusal code that retained it.
- **The successor commits with the settlement, or not at all** (R4, T4): four
  cases. The settlement's own transaction is read back holding the report, a
  `pending` gate on the same lineage, version 2 with the successor's ceiling,
  its run, its step and its evidence pack, the superseded old version, and no
  hold on the new version — a successor is work to decide, not work approved. A
  trigger arranged to raise on the successor's version insert, which
  `writeProposal` reaches only after the report, the lease release and the
  classifier have written, leaves **neither**: no report, no version 2, the
  lease still `live`, the hold still `held`, the run still `claimed` and the
  envelope still carrying the whole hold; with the trigger gone the same
  handback settles and proposes. A successor past the cap, in another currency,
  at a non-positive ceiling, or at a third formal round is refused
  `SUCCESSOR_OUT_OF_BOUNDS` before any write, and the claim is read back live
  and holding, then settled. A stale fence retains its report and creates no
  successor: the lineage still has its one version and its one gate.
- **An expired lease is classified by its owning transaction** (R5): the next
  pickup fences the old lease, the old hold is read back `abandoned` under
  `lease_expired_and_fenced`, a fresh reservation is read back `held` on the
  same still-approved version, and the envelope carries one hold's worth rather
  than two. A second case leaves a fenced lease with an unclassified hold and
  asserts `replayRecordedTransitions` finishes it. Until lane
  L2-DELEGATION-FIX this was **unreachable through a command**: the delegation
  expires with the lease and `delegations_one_live_per_purpose_idx` does not
  read expiry, so the spent delegation held the slot and the second pickup
  raised 23505 rather than recovering. `mintDelegation` now settles the spent
  row in the same transaction as the fresh hold (AUTHORITY.md,
  `DELEGATION_ALREADY_LIVE`), so the recovery is proved end to end over HTTP as
  well as in the runtime, with the abandoned credential answering
  `DELEGATION_NOT_LIVE` and the new one working.
- **The schedules go through the command entry** (W01, W03, W05 and the
  heartbeat), in `tests/runtime/schedules-*.test.ts`. The helper cases above
  call `propose` and `handback` directly. These run a person's body through
  `executeCommand` and an agent's through `executeAgentCommand`, the functions
  the HTTP boundary mounts (`schedules-harness.ts:1-21`). A third connection
  holds a row the racers need. Each racer starts only once the one before it is
  seen parked in `pg_locks`, and then the holder lets go. The order is
  observed, not slept through. W01 cuts the connection at `COMMIT` with an
  in-test TCP relay, `cutProxy`: once before the server receives the commit and
  once after it commits (`schedules-harness.ts:402-425`). `connect` defaults to
  a pool of one (`tenancy/database.ts:68`), so each racer needs a `Database` of
  its own. Two calls through one `Database` queue in the client and never meet
  in the server.
- Append-only is asserted **twice**: the application role is refused by
  privilege, and the owner — who does hold `update` — is refused by the trigger.
  Without the second half a later migration granting `update` would silently
  make the trail amendable.

## The work controls

The ledger's support controls reach this package through declared operations
([API.md, "The support controls"](API.md#the-support-controls)), never through
direct SQL.

- **Cancellation** is `cancelAndClassify` (`recovery.ts:557-642`), reached by
  `task.cancel`. In one transaction under the complete ordered lock set, it
  makes the lineage terminal, releases each live lease on the lineage, revokes
  the delegation each lease was issued under, ends `planned` and `claimed` runs
  as `cancelled`, and classifies the lineage's own holds. The delegation's
  recorded cause is `work_retired` (`recovery.ts:403`). A run already handed
  back keeps that state. The cancelled agent's next call answers
  `DELEGATION_NOT_LIVE`, and the same agent can pick up a restarted lineage
  (`tests/runtime/lifecycle-cancel.test.ts`). A handback that commits between
  discovery and the locks leaves a smaller set, and the cancellation goes on
  with it (`tests/runtime/lifecycle-cancel-race.test.ts`).
- **Authority** for `task.cancel` and `task.restart` is `write` on the task
  named in `recordId`, so a record-scoped writer controls its own lineage
  (`commands/surface.ts:305-306`, `authorisedOn: 'record'`;
  `tests/commands/control-scope.test.ts`). `task.pickup`, `task.heartbeat` and
  `task.handback` are authorised as `write` on the task their reservation or
  lease belongs to (`authorisedOn: 'claim'`, `commands/surface.ts:229-241`,
  `:309`), the scope the runtime and `grant.revoke` ask under their locks. A
  record-scoped writer works their own lease on that task. An id that resolves
  to nothing is asked at business scope, so a foreign and a fabricated id get
  the same answer (`claimScopeOf`, `commands/prepare.ts:368-395`).
- **Authority loss** is classified by the revocation that caused it.
  `grant.revoke` and `delegation.revoke` end in `classifyAuthorityLoss`
  (`recovery.ts:704-828`, called from `commands/authority-controls.ts:241` and
  `:315`). Work authority for a claim is `write` on the task collection, the
  action `task.pickup`, `task.heartbeat` and `task.handback` are declared under.
  Losing `read` or `comment` does not end a claim (`dependents`,
  `authority-controls.ts:125-174`). Under the ordered lock set:
  - An agent's attempt that lost its work authority has its delegation
    revoked, its live lease released and its holds classified
    `authority_revoked`, with the delegation as the recorded cause. The
    delegation's `revocation_cause` is `authority_lost`, written in the same
    transaction (`recovery.ts:784-791`, migration 0023). The agent's next call
    on its still unexpired credential answers `DELEGATION_NARROWED`, and
    nothing is reactivated.
  - `grant.revoke` also ends a person's own lease. When the revoked grant, or
    one it issued, was the holder's `write` on the task collection, through
    their person or actor subject, and no other live `write` covers the task,
    the same transaction releases the lease and classifies its hold
    `authority_revoked`, with the grant id as the recorded cause
    (`authority-controls.ts:241-275`).
  - The recheck after the revocation asks `write` at record scope on the task
    (`stillAuthorised`, `:176-192`). A holder whose business-wide `write` is
    revoked while a record-scoped `write` on the task remains keeps the lease,
    and can renew and hand it back. So does an attempt whose person still
    holds `write` through another grant.
  - Each run whose claim ended goes back to `planned`, not to a terminal state
    (`reopenRuns`, `recovery.ts:418-430`). The abandoned hold is never revived:
    a claimant with current authority gets a fresh hold and attempt
    ([Why the lease is fenced](#why-the-lease-is-fenced)).
  - Both revocations answer with `detail.classifiedHolds`: the ids of the
    reservations the revocation classified, and nothing else about them
    (`authority-controls.ts:193-198`).
  - A marked or observed attempt keeps its full hold as `quarantined`.

  `replayRecordedTransitions` also finds a revocation that committed without
  its classification (`recovery.ts:462`, `:476-480`). Its production caller is
  API startup ("Restart recovery at API startup" above); the classifier cases
  are in `tests/runtime/lifecycle-authority-loss.test.ts` (six cases).

- **Restart** is `restart` (`restart.ts`), reached by `task.restart`. It reads
  the terminal lineage's last version and step and calls `propose` with
  `restartsLineageId`. Under the old lineage's lock, `propose` refuses a
  lineage on another task (`LINEAGE_NOT_ON_TASK`), a live or completed one,
  and one already restarted (`TRANSITION_NOT_PERMITTED`, the twentieth runtime
  code, 409). It then writes `restarts_lineage_id`, the column 0010 declared
  for this. The new lineage has version 1, a pending gate and no hold. Nothing
  the old lineage held is reopened or reused (G05). Its `expiresInSeconds`
  takes the same seven-day maximum as `task.propose`
  ([Why a lapsed gate reads expired](#why-a-lapsed-gate-reads-expired-but-stays-pending)).
- **Heartbeat** is `heartbeat` (`heartbeat.ts`), reached by `task.heartbeat` on
  both prefixes. Under the lease and delegation locks, the caller must be the
  holder and send the task's newest fence, or it is `LEASE_NOT_OWNED`. An agent
  presents the lease's own delegation. A person renews their own
  delegation-free lease under their current `write` on the task
  (`heartbeat.ts:130-147`). A lease that is not live, is past its
  instant, or whose delegation is settled, revoked or expired is
  `LEASE_EXPIRED` and is not revived. One renewal reaches at most
  `MAXIMUM_RENEWAL_SECONDS` (3600) past now and never past
  `MAXIMUM_LEASE_LIFETIME_SECONDS` (8 hours) after the pickup. The delegation's
  expiry is copied from the lease row. **No timer grants authority**: nothing
  runs on its own, a lease that stops beating expires, and the next pickup
  fences it as before. Bounded unstarted recovery stays the owning operations'
  classifier (W04), reached by pickup, cancellation and restart replay, with
  no sweeper added.
- **Open on the heartbeat.** The two bounds, 1 hour a beat and 8 hours in
  total, are lane constants (`heartbeat.ts:32-34`), not an owner policy. They
  are lane L3-CONTROLS's choice and await root or owner confirmation. The
  8-hour total is enforced in SQL as
  `greatest(expires_at, least(now() + renewal, acquired_at + 8 hours))`
  (`heartbeat.ts:112-120`). So past it a beat keeps `expires_at` and never
  extends it, and a renewal never shortens a lease.
  `tests/runtime/schedules-heartbeat.test.ts` reaches the boundary by moving
  the lease's `acquired_at` back on the database clock, then beats through
  `task.heartbeat`.

## The delegation credential key

An agent's pickup returns its delegation credential once, and the delegation
keeps only its digest. So that a lost pickup response can be answered again,
the credential is derived rather than drawn. It is HMAC-SHA256 over
`["ops-astro/delegation-credential/v1", keyId, businessId, agentActorId, delegationId]`
under a dedicated delegation credential key (`credentialEncoding`,
`authority/credential-keys.ts:83-91`; minted at `authority/delegations.ts:254-263`).

- **Custody.** The key is never the gate-signing key or the Supabase JWT
  secret. It lives outside the database and outside tracked files:
  `DELEGATION_CREDENTIAL_KEY_ID` (the active id) and
  `DELEGATION_CREDENTIAL_KEYS` (`id:base64url` pairs, each at least 32 bytes),
  or the gitignored 0600 file `.local/delegation.env`
  (`credential-keys.ts:120-165`, `:177-211`). `scripts/local-seed.mjs` or the
  first use creates that file once, with a fresh random key id, and never
  rewrites it (`local-seed.mjs:728-739`). With neither setting present, the
  file is read, and created if absent (`configuredCredentialKeys`, `:220-230`).
  The database stores only `credential_hash` (SHA-256) and the nonsecret
  `credential_scheme` and `credential_key_id` (migration 0022).
- **Backup.** Back up the delegation key file with the database. A database
  restored without its matching keyring cannot replay a lost pickup response:
  those replays fail closed with `DEPENDENCY_NOT_LANDED`, and presented tokens
  still verify by digest. Every API process serving one database must hold the
  same keyring.
- **Rotation and retention.** Rotate by adding a new id to
  `DELEGATION_CREDENTIAL_KEYS` and moving `DELEGATION_CREDENTIAL_KEY_ID` to it.
  Keep every old id while any live delegation minted under it may still need a
  pickup replay; a heartbeat can extend that. Never replace the bytes under an
  existing id. Ordinary replay never rotates or revokes a credential.
- **A missing or malformed key.** A keyring that is malformed or half
  configured stops the API at boot with the reason, never the bytes
  (`apps/api/server.ts:169-176`). An agent `task.pickup` without a usable
  keyring refuses `DEPENDENCY_NOT_LANDED` before claiming anything
  (`commands/tasks-runtime.ts:365-382`). A replay whose delegation names a key
  this process does not hold answers `DEPENDENCY_NOT_LANDED`
  `['task.pickup', 'delegation credential key <id>']`. A derived token whose
  digest does not match answers `DEPENDENCY_NOT_LANDED`
  `['task.pickup', 'delegation credential integrity']`. Neither rewrites the
  receipt or mints a replacement (`commands/agent-envelope.ts:840-858`).

**The pickup replay.** A lost pickup response is retried with the identical
operation id and body and no delegation credential. It returns the original
handles and the same credential only while the delegation is live, the
delegating person's grants still cover the purpose, and the receipt's lease,
reservation, attempt and approved version are still bound, live and current.
Otherwise it gives the current refusal (`DELEGATION_NOT_LIVE`,
`DELEGATION_NARROWED`, `LEASE_NOT_OWNED`, `LEASE_EXPIRED`,
`RESERVATION_NOT_CLAIMABLE`) and no receipt content (`replayPickup`,
`commands/agent-envelope.ts:762-861`). The register keeps the handles with a
null credential (`storable`, `:722-725`).

**The legacy limit.** Delegations minted before migration 0022 are
`credential_scheme = 'legacy-random'`. Their random credentials cannot be
recovered from their SHA-256 digests. Tokens already delivered stay valid. A
lost response on a legacy pickup replays its handles with `credential: null`
and `CREDENTIAL_NOT_REPLAYED` (`agent-envelope.ts:824-829`). Recovery is
`task.cancel`, or a new pickup once the old lease has expired. No migration or
code path relabels a legacy row as derivable, and 0022's trigger forbids it.

## What is not here

- **No worker, sweeper, top-up, write-off or effect activation.** `apps/worker/`
  is still `.gitkeep`.
- **No audit row from this package.** `audit_events` is written through L3's
  command envelope, which owns the actor and the operation identity. The first
  attempt to write one from `handback.ts` aborted the whole transaction on a
  column that does not exist, which is the right answer to a second writer
  reaching into another unit's trail.
- **No HTTP surface of its own.** This package is reached only through L3's
  command surface: `task.propose`, `task.decide`, `task.pickup`,
  `task.handback`, `task.queue`, `task.cancel`, `task.restart` and
  `task.heartbeat` are routed there, and its codes are
  registered in `commands/register.ts` and `apps/api/status.ts`
  ([API.md](API.md#the-operations-l4s-runtime-made-possible)).
- **No operation-identity replay.** `propose` and `decide` take no
  `operationId`; replay is L3's envelope, which already owns that mechanism for
  every other command.
- **Restart (W06) is tested outside this package, and not yet closed.** Every case here is a
  transaction boundary and a fresh connection to a server that never stopped.
  `pnpm verify:restart` restarts a declared, disposable Postgres and the API
  process and compares the lineage, gate, decision, reservation, lease,
  attempt, delegation, receipt and register identities with their states. It
  then drives replays, the handback, a gate that lapsed while nothing ran and a
  Request Changes round over HTTP against the new process, and cancels and
  restarts a lineage there through the declared `task.cancel` and
  `task.restart`. The browser leg (B6) carries a gate, lease and attempt across
  a restart on a lane stack; its run at the integrated candidate is pending.
  The coverage table and the open items are in `docs/local/PROOFS.md`.
- **No full cover for a decision on read.** The verified read leaves `round`,
  `decided_at`, the acting identity and the evidence digest outside the link,
  does not catch removal of the newest decision, and knows one signing key
  ([A decision is verified before a read returns it](#a-decision-is-verified-before-a-read-returns-it)).
- **No production caller of `replayRecordedTransitions`.** The owning
  operations classify their own transitions, and the replay is exercised by the
  tests only ([The work controls](#the-work-controls)).
- **No settlement of actual expenditure.** `handback` refuses any non-null
  `actualMinor` (R6). This head dispatches nothing, so it observes nothing it
  could settle; the settlement path belongs to the later authorised,
  evidence-backed accounting work along with its own proofs.
