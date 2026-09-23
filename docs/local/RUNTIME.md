<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The bounded runtime, as lane L4 built it

Propose, decide, pick up, hand back, and the one classifier that closes work
nobody can claim any more. The authority half is [AUTHORITY.md](AUTHORITY.md)
and the data half is [DATA.md](DATA.md); this file is what happens between a
person deciding and a hold being released.

Nothing here is a plan. Every mechanism below is in the tree with a proof
beside it, and [what is not here](#what-is-not-here) says what is not.

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

interface HandbackRequest {
  leaseId;
  fence: number; // the fence it believes it owns
  outcome: 'completed' | 'failed';
  report: Record<string, unknown>;
  actualMinor: number | null; // null is this head's honest answer
}
interface HandedBack {
  leaseId;
  reservationId;
  attemptId;
  reservationState: 'actual' | 'abandoned' | 'held' | 'quarantined';
  classification: Classification | null;
  envelopeHeldMinor: number;
  envelopeActualMinor: number;
}
```

### Refusal codes L3 must register

`RuntimeRefusalCode` is exported as this package's own type and is deliberately
**not** added to `commands/register.ts`, which is L3's file, for the reason
AUTHORITY.md gives: a module reaching into the command surface to add its own
codes is the coupling the register exists to prevent. `SUGGESTED_STATUS` in
`refusals.ts` carries the same table in code.

| Code                        | Suggested status | Caller-visible                            |
| --------------------------- | ---------------- | ----------------------------------------- |
| `VERSION_SUPERSEDED`        | 409              | yes — re-read and decide the live version |
| `EVIDENCE_MISMATCH`         | 409              | yes                                       |
| `GATE_NOT_FOUND`            | 404              | yes                                       |
| `GATE_ALREADY_DECIDED`      | 409              | yes — the loser of a decision race        |
| `GATE_EXPIRED`              | 410              | yes                                       |
| `LINEAGE_TERMINAL`          | 409              | yes                                       |
| `CHANGE_ROUNDS_EXHAUSTED`   | 409              | yes                                       |
| `BUDGET_UNAVAILABLE`        | 409              | yes — this envelope has no room           |
| `BUDGET_EXHAUSTED`          | 402              | yes — the cap behind it has none          |
| `PROPOSAL_OUT_OF_SCOPE`     | 403              | yes                                       |
| `RESERVATION_NOT_CLAIMABLE` | 409              | yes                                       |
| `LEASE_HELD`                | 409              | yes                                       |
| `LEASE_NOT_OWNED`           | 403              | yes — a stale or foreign fence            |
| `LEASE_EXPIRED`             | 410              | yes                                       |
| `SCOPE_NOT_GRANTED`         | 403              | yes                                       |

`decideAsAgent` returns L2's `DELEGATION_EXCLUDES_DECISION`, which AUTHORITY.md
already tells L3 to register. It is not re-derived here.

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

## What the classifier will not do

`recovery.ts` closes the lifecycle of work that is durably no longer claimable.
It is invoked from inside the authorised operations that write those
transitions, and `classifyUnderLocks` takes no lock of its own because its
caller holds the complete set already.

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

`tests/runtime/gate.test.ts` and `tests/runtime/lease.test.ts`, 19 cases, all
against a real Postgres migrated from empty.

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
- **No HTTP surface and no registry entry.** L3 wires these onto
  `commands/register.ts` and `apps/api/status.ts`.
- **No lock-order or deadlock proof.** `locks.ts` is asserted only by the one
  forced approval race. Two transactions taking cap, envelope and gate in the
  contract's order have not been watched into a forced interleaving, and the
  wrong order has not been shown refused before Postgres detects it.
- **No operation-identity replay.** `propose` and `decide` take no
  `operationId`; replay is L3's envelope, which already owns that mechanism for
  every other command.
