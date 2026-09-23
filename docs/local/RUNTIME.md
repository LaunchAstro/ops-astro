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

## The one rule the whole thing rests on

**Discover, lock, re-read, then write.** The lock order is the contract's — cap,
envelope, task, run, step, lineage, gate, lease, delegation, reservation,
operation — and it is in `locks.ts` as code rather than in four handlers as
prose. `acquire` takes the whole set, sorts it by class and by key inside a
class, and issues the statements in that order, so a handler that lists a lease
before a cap still takes the cap first.

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

### Refusal codes, as L3 registered them

`RuntimeRefusalCode` is exported as this package's own type and is deliberately
**not** added to `commands/register.ts`, which is L3's file, for the reason
AUTHORITY.md gives: a module reaching into the command surface to add its own
codes is the coupling the register exists to prevent. `SUGGESTED_STATUS` in
`refusals.ts` carries the same table in code. L3 has registered every code
below at the status suggested here (`apps/api/status.ts`), and
`fromRuntime` (`commands/tasks-runtime.ts:71`) carries a runtime refusal onto
the command surface unchanged. Each operation's refusals, with their routes,
are in [API.md](API.md#the-operations-l4s-runtime-made-possible).

| Code                             | Status | Caller-visible                            |
| -------------------------------- | ------ | ----------------------------------------- |
| `VERSION_SUPERSEDED`             | 409    | yes — re-read and decide the live version |
| `EVIDENCE_MISMATCH`              | 409    | yes                                       |
| `GATE_NOT_FOUND`                 | 404    | yes                                       |
| `GATE_ALREADY_DECIDED`           | 409    | yes — the loser of a decision race        |
| `GATE_EXPIRED`                   | 410    | yes                                       |
| `LINEAGE_TERMINAL`               | 409    | yes                                       |
| `CHANGE_ROUNDS_EXHAUSTED`        | 409    | yes                                       |
| `BUDGET_UNAVAILABLE`             | 409    | yes — this envelope has no room           |
| `BUDGET_EXHAUSTED`               | 402    | yes — the cap behind it has none          |
| `PROPOSAL_OUT_OF_SCOPE`          | 403    | yes                                       |
| `LINEAGE_NOT_ON_TASK`            | 409    | yes — the lineage is another task's       |
| `CAP_BINDING_MISMATCH`           | 409    | yes — the envelope's cap is the cap       |
| `ACTUAL_EXPENDITURE_UNSUPPORTED` | 422    | yes — this head observed no spending      |
| `SUCCESSOR_OUT_OF_BOUNDS`        | 409    | yes — cap, currency or rounds             |
| `RESERVATION_NOT_CLAIMABLE`      | 409    | yes                                       |
| `LEASE_HELD`                     | 409    | yes                                       |
| `LEASE_NOT_OWNED`                | 403    | yes — a stale or foreign fence            |
| `LEASE_EXPIRED`                  | 410    | yes                                       |
| `SCOPE_NOT_GRANTED`              | 403    | yes                                       |

`decideAsAgent` returns L2's `DELEGATION_EXCLUDES_DECISION`, which L3 registered
from AUTHORITY.md's table. It is not re-derived here.

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

## Why the lease is fenced

The fence is the identity of the claim, not of the task, and it is monotonic per
task under the task lock. A holder whose lease was replaced presents the old
fence and nothing changes: `LEASE_NOT_OWNED` on a superseded or mismatched
fence, `LEASE_EXPIRED` when the lease itself is over. Its report can be retained
separately; it cannot settle the replacement's work.

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
- Append-only is asserted **twice**: the application role is refused by
  privilege, and the owner — who does hold `update` — is refused by the trigger.
  Without the second half a later migration granting `update` would silently
  make the trail amendable.

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
  `task.handback` and `task.queue` are routed there, and its codes are
  registered in `commands/register.ts` and `apps/api/status.ts`
  ([API.md](API.md#the-operations-l4s-runtime-made-possible)).
- **No operation-identity replay.** `propose` and `decide` take no
  `operationId`; replay is L3's envelope, which already owns that mechanism for
  every other command.
- **Restart (W06) is tested outside this package, and not yet closed.** Every case here is a
  transaction boundary and a fresh connection to a server that never stopped.
  `pnpm verify:restart` restarts a declared, disposable Postgres and the API
  process and compares the lineage, gate, decision, reservation, lease,
  attempt, delegation, receipt and register identities with their states;
  the coverage table and the W06 items still open are in `docs/local/PROOFS.md`.
- **No settlement of actual expenditure.** `handback` refuses any non-null
  `actualMinor` (R6). This head dispatches nothing, so it observes nothing it
  could settle; the settlement path belongs to the later authorised,
  evidence-backed accounting work along with its own proofs.
