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
and accepted, read "proved" below as "a test asserts it", not as "done". The
joint gates were green at 158d6de, at d6787c5, at c53aa25, at 9d2dbde and
again at efd5009 (`pnpm test` 5,491 passed and 24 skipped, `tests/acceptance`
3,852 and 16, `db:conformance` 129 named suites, 4,800 of 4,800). The head these
docs describe, 1ddb286, is efd5009 plus PR A's gate tooling (`135dd75`).
[PROOFS.md](PROOFS.md) holds the full count table.

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
`pickup` returns its `declaredIncompleteness` in the payload so no caller has
to discover it.

At this head an attempt in state `dispatched` is bound to a live lease and
nothing more. Pickup sets `state = 'dispatched'` and the attempt's `lease_id`
together (`pickup.ts`, `pickup`). `dispatch_marker` stays false, since no code
path sets it, and nothing is dispatched outside the database. Migration 0014
declares `dispatched` as an attempt state and keeps `dispatch_marker` as a
separate column (`migrations/0014_runtime_attempts.sql`,
`attempts_state_known`). The name stays: renaming the state needs a migration
and changes no behaviour.

A gate is bound to its version, not only to its business, since migration
0021 (`migrations/0021_runtime_gate_version_binding.sql:36-53`). Three
composite foreign keys hold it: the gate's run plans the gate's version
(`gates_run_in_same_version`), its step is a step of that run
(`gates_step_in_same_run`), and its version is a version of its lineage
(`gates_version_in_same_lineage`). A gate pointed at another version's run or
step cannot be written, so it cannot be decided (ledger G01).

## The one rule the whole thing rests on

**Discover, lock, re-read, then write.** The lock order is the contract's: cap,
envelope, task, run, step, lineage, gate, lease, delegation, reservation,
operation. One class goes in front of it. The order lives once, in `locks.ts`,
and the four handlers do not repeat it. `acquire` takes the whole set, sorts it by
class and by key inside a class, and issues the statements in that order, so a
handler that lists a lease before a cap still takes the cap first.

The class in front is `chain`, the business's decision chain (R10, `LOCK_ORDER`,
`locks.ts:26-45`). It has no row, so it is a transaction-scoped advisory lock
(`:105-110`). `task.decide` takes it before the cap (the `chain` request in
`decide`, `decide.ts`), so a second approval racing in the same business waits
on the chain lock, not on the cap row.

`task.propose` takes cap, envelope, task, lineage, then the superseded version's
holds, live lease and delegation, in one ordered call (`lockProposal`,
`propose.ts`). It is declared `targetLock: 'runtime'`
(`COMMAND_SURFACE`, `commands/surface.ts`), so the command envelope only reads
the task and does not lock it (`prepareCommand`, `commands/prepare.ts`).
`proposeOnTask` compares the expected revision once the runtime's locks are held
(`commands/tasks-propose.ts`).

Grants stay outside that order. `task.pickup` share-locks the grant chain behind
the claim's authority before it acquires the runtime set: the claimant's own
grants in the collection and every grant they descend from
(`holdCoveringGrants`, `pickup.ts`, called from `pickup`). That mirrors
`grant.revoke`, which takes `for update` on the revoked grant before any runtime
lock (`revokeGrantAsManager`, `commands/authority-controls.ts`). The two
serialise on the grant row. A revocation that locks first is seen by the
pickup's authority read. One that locks second waits for the pickup to commit
and then finds its lease in its first discovery. So a pickup cannot grow a
revocation's affected set between discovery and locks. Neither side waits on a
grant while it holds runtime locks. `tests/runtime/retry-bounds.test.ts` traces
the order on a real run: the revocation's first locking statement is its grant
row, and it waits on the parked pickup's transaction for that row.

`decide.ts` once opened the task's envelope before acquiring its locks, a
write before the lock set. Two approvals racing one task both found no
envelope, both inserted, and the loser met `duplicate key value violates unique
constraint "task_envelopes_task_open_idx"` instead of the typed
`GATE_ALREADY_DECIDED` it had earned. The gate race proof caught it. Envelope
creation now happens under the locks, and the discovery pass before them only
reads.

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

**The operands on the command surface.** On `task.pickup` and `task.heartbeat`,
for a person and an agent alike, a present `leaseSeconds` must be a whole number
of seconds from 1 to 3600. `null`, a fraction or anything else is
`FIELD_VALUE_INVALID` 422. Leaving it out gives 15 minutes, for a pickup and a
renewal alike (`readLeaseSeconds` and `DEFAULT_RENEWAL_SECONDS` in
`commands/tasks-lease.ts`, `DEFAULT_LEASE_SECONDS` in
`commands/tasks-pickup.ts`). A present handback `report` must be an object:
`null`, an array or a string is `FIELD_VALUE_INVALID` on both prefixes (the
report check in `settle`, `commands/tasks-handback.ts`). The pickup's brief
lists `excludedOperations` as `{ operation, reason }` pairs (`exclusionsFor`,
`commands/tasks-pickup.ts`), and its `handbackShape` names the operands
`task.handback` reads (`handbackShapeFor`, `commands/pickup-handback-shape.ts`).

### Refusal codes, as L3 registered them

`RuntimeRefusalCode` is read off the refusal register's rows marked `runtime`
(`packages/core-records/src/commands/register.ts`). Each row carries its HTTP
status, and `statusOf` in the same file reads that column, so a runtime code is
declared once. `SUGGESTED_STATUS` (`core-runtime/src/refusals.ts`) is a view
derived from those rows. Nothing in production reads it, and the tests that
census the runtime's codes keep it exported. `fromReasoned`
(`commands/refusal.ts`) gives a runtime refusal the shape of authority's and a
delegation's, reason then fix. Each operation's refusals, with their routes, are in
[API.md](API.md#the-operations-l4s-runtime-made-possible).

| Code                             | Status | Caller-visible                                                 |
| -------------------------------- | ------ | -------------------------------------------------------------- |
| `VERSION_SUPERSEDED`             | 409    | yes, re-read and decide the live version                       |
| `EVIDENCE_MISMATCH`              | 409    | yes                                                            |
| `GATE_NOT_FOUND`                 | 404    | yes                                                            |
| `GATE_ALREADY_DECIDED`           | 409    | yes, the loser of a decision race                              |
| `GATE_EXPIRED`                   | 410    | yes                                                            |
| `LINEAGE_TERMINAL`               | 409    | yes                                                            |
| `CHANGE_ROUNDS_EXHAUSTED`        | 409    | yes                                                            |
| `BUDGET_UNAVAILABLE`             | 409    | yes, this envelope has no room                                 |
| `BUDGET_EXHAUSTED`               | 402    | yes, the cap behind it has none                                |
| `PROPOSAL_OUT_OF_SCOPE`          | 403    | yes                                                            |
| `LINEAGE_NOT_ON_TASK`            | 409    | yes, the lineage is another task's                             |
| `CAP_BINDING_MISMATCH`           | 409    | yes, the envelope's cap, and its currency, is the cap          |
| `ACTUAL_EXPENDITURE_UNSUPPORTED` | 422    | yes, this head observed no spending                            |
| `SUCCESSOR_OUT_OF_BOUNDS`        | 409    | yes, cap, currency or rounds                                   |
| `RESERVATION_NOT_CLAIMABLE`      | 409    | yes, one answer for none, unapproved and already picked up     |
| `LEASE_HELD`                     | 409    | yes, two held reservations on one task                         |
| `LEASE_NOT_OWNED`                | 403    | yes, a stale or foreign fence                                  |
| `LEASE_EXPIRED`                  | 410    | yes                                                            |
| `SCOPE_NOT_GRANTED`              | 403    | yes                                                            |
| `TRANSITION_NOT_PERMITTED`       | 409    | yes, restart of a live, completed or already restarted lineage |

`decideAsAgent` returns L2's `DELEGATION_EXCLUDES_DECISION`, which L3 registered
from AUTHORITY.md's table. It is not re-derived here.

`RESERVATION_NOT_CLAIMABLE` gives the same two sentences whether the reservation
does not exist, has no approval behind it, or is already picked up by another
live lease (`NOT_CLAIMABLE_REASON` and `NOT_CLAIMABLE_FIX`, `pickup.ts`;
`claim`, `commands/tasks-pickup.ts`). The holding lease is never named.

`LEASE_HELD` is reachable. Two lineages approved on one task, under an envelope
an earlier handback left open, give two held reservations, and the second pickup
meets the first one's live lease (the note beside `UNPRODUCED_CODES` in
`commands/register.ts`; `tests/commands/lease-held-reach.test.ts`). Its reason
still names the task (the `LEASE_HELD` refusal in `pickup`, `pickup.ts`).

`LEASE_NOT_OWNED` for a lease the caller does not hold, on heartbeat and
handback, is a constant that echoes neither the presented lease nor the fence
(`notOwned` in `heartbeat`, `heartbeat.ts`; in `handback`, `handback.ts`, "no
such lease in this business" and "the named lease is not this caller's").
A stale or superseded fence on a lease the caller does hold still names the
lease and the fences (`fenceVerdict`, `handback.ts`).
`DELEGATION_OUT_OF_PURPOSE` for a call on another resource names the
delegation's own scope and not the presented one (`checkDelegatedAuthority`,
`authority/delegations.ts`).

## Why the money is two columns

`task_envelopes` carries `held_minor` and `actual_minor` separately, and the
reservation's terminal state is `abandoned`, never a zero `actual`. A released
hold that wrote `actual_minor = 0` would be a claim that the work ran and cost
nothing. Nothing in this head runs, so that claim would be an invention, and the
schema refuses it: `reservations_actual_only_when_actual` makes carrying a
number and being `actual` the same fact.

`BUDGET_UNAVAILABLE` and `BUDGET_EXHAUSTED` are separate because a caller told
the wrong one raises the wrong ceiling. The first is the task's envelope, the
second is the cap behind it.

`core-runtime/src/budget.ts` is the one cap-sum source: decide's preflight,
`reserve`, and handback's successor bound (`withinBounds`,
`core-runtime/src/handback.ts`) all read `capCommitted` and test room with
`exceeds`. It also holds the envelope and cap verdicts (`envelopeVerdict`,
`capVerdict`) and the task's open envelope (`openEnvelopeOf`). A missing cap is `BUDGET_UNAVAILABLE` at preflight and at
`reserve` alike, because a ceiling that cannot be read is not room (thermo O2,
lead ruling, fail closed).

Both checks compare exact minor units. The totals and limits come from SQL as
text and are compared as `bigint`, so a valid cap above 2^53 is never exceeded
through rounding (`budgetRoom` in `core-runtime/src/decide.ts`, `exceeds` in
`core-runtime/src/budget.ts`). The response converts fields such as
`heldMinor` to numbers separately.

Storage holds the cap ceiling as well, since migration 0025 (constraint
`budget_caps_ceiling`). Whichever path wrote the rows, the committed total under
a cap, `sum(held_minor + actual_minor)` over every envelope drawing on it, never
exceeds `limit_minor` at commit. Deferred constraint triggers on
`task_envelopes` and `budget_caps` claim the cap row by rewriting its limit
unchanged, then sum. Under read committed, a competing transaction waits,
re-sums and is refused `23514` (`check_violation`, `budget_caps_ceiling`). Under
repeatable read or serializable, a transaction whose snapshot predates a
competing commit is refused `40001` (`serialization_failure`) and must retry in
a fresh snapshot, so at those levels two concurrent raises under one cap
serialise even when they would fit together. The app runs at read committed and
nothing in it retries `40001`. Only a write that can
raise the total is checked: a nonzero insert, a growing total, a move to
another cap, or a falling limit. The command refuses first with a reason, and
storage refuses second (`tests/runtime/cap-storage-backstop.test.ts`).

The cap is a ceiling in one currency. When `task.decide` approves, it refuses a
version whose currency differs from the cap's, or from that of the task's open
envelope, with `CAP_BINDING_MISMATCH` before the first write (`budgetRoom`).
`openEnvelope` checks again at the write that binds them. Storage holds the
binding too, since migration 0024. The envelope's `(business_id, cap_id,
currency)` references the cap's `(business_id, id, currency)`
(`task_envelopes_cap_currency_fkey`). So an envelope in another currency cannot
be written, and a cap's currency is fixed once any envelope draws on it
(`migrations/0024_cap_envelope_currency_binding.sql`). `SUCCESSOR_OUT_OF_BOUNDS`
is the same check for a handback's successor.

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
- **Both use the database clock.** `decide` reads `clock_timestamp()` once,
  after it acquires its locks (`lockedInstant`, `core-runtime/src/clock.ts`),
  so a decide that waited on a lock past the deadline is refused. The read
  takes no lock, so it uses `now()` inside its own statement. Neither uses the
  application's clock.
- **The boundary is inclusive.** `expires_at` at or before the clock is
  expired on both sides, so at the deadline instant the read says expired and
  the decide refuses.
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

`task.read` verifies every decision it returns before it answers.
`readTaskProposals` (`core-records/src/reads/proposals.ts`) calls
`readVerifiedProjection` (`core-records/src/reads/verified-decisions.ts`). The
read walks the business's decision chain from genesis to the newest decision it
returns. For each row it recomputes the payload digest from the stored JSON,
then checks the signature and the link hash (`verifyChain`,
`core-runtime/src/signing.ts`). Each row is checked under its own link version,
1, 2 or 3, which its signed payload names (`linkVersionOf`), and under the key
its `signing_key_id` names. After the chain holds, the read compares each row's
columns with its own signed payload (`boundColumns`). It then checks the
decisions against what the gates and lineages record (U1, `missingDecisions`). A
decided gate has the one decision that moved it, a decision's gate is in the
state that decision produced, a gate-rejected lineage has its rejection, and no
gate reaches a round its requested changes do not account for.

A decision that does not verify fails the read. So do stored decisions when no
key is configured. The failure is `DecisionIntegrityError`, code
`DECISION_INTEGRITY`. Over HTTP it is a fault, 500 with fixed words and no task
in the body (`ReadIntegrityFault`, `reads/dispatch.ts`), not a refusal.
Verifying writes nothing: the stored rows are left as they were found.
`tests/reads/verified-decisions.test.ts` and
`tests/reads/decision-integrity-read.test.ts` tamper as the database owner and
assert each failure, and that a clean read changes nothing.

The chain and the gate and lineage facts it is checked against are read in one
statement, so they are one snapshot (`readSnapshot`). The read runs
read-committed, where each statement sees what was committed when it began. A
chain read before a `task.decide` commits and a gate read after it would find an
approved gate with no decision and fault on intact evidence. One statement
answers the old view or the new one. Nothing else changes isolation or takes a
lock. `tests/reads/decision-snapshot.test.ts` pauses the read, commits a real
`task.decide` on another connection, and checks that the read answers without
`DECISION_INTEGRITY`. It covers the first decision on a pending gate and a later
decision on a lineage that already has one. A missing decision still fails the
same read.

The proposal read takes its versions, gates and reservations in that same
statement (`readVerifiedProjection`), so one answer never shows a gate `pending`
beside its own verified decision. `tests/reads/projection-snapshot.test.ts` and
`tests/surfaces/proposal-snapshot.test.tsx` assert that relation and the
decision controls the page draws from it.

Its limits:

- A v1 row's link covers its id, sequence, gate, version, decision, deciding
  person, payload digest and signature, and not its round, decision time,
  lineage, acting identity, evidence digest or key id (`decisionLink`,
  `signing.ts`). v2 and v3 links cover those too, but the link hash is unkeyed.
  On v1 and v2 rows the signed payload does not hold the round, time, lineage,
  acting identity, id, sequence or previous link, so a writer with owner access
  who recomputes every later link can change them and the read still verifies.
  v3 signs them, and the read compares each with the payload. On every version
  the gate, version, decision, deciding person and evidence digest are compared
  with the signed payload. The read labels each decision with its `linkVersion`
  and the `signedFields` its signature covers. v1 and v2 rows are verified as
  they are and never rewritten.
- U1 compares the decisions only with gate and lineage state. Removing the
  newest decision is caught while its gate, its lineage or a later round still
  records the outcome. A writer with owner access who removes it and also
  returns the gate to `pending`, with the lineage live and no later round,
  leaves a chain and facts that agree, and the read does not see it.
- The verifier resolves each row's key id, so a chain that spans a key change
  can verify. The read's resolver holds only the configured key
  (`configuredKeys`, `proposals.ts`), so a row signed under an earlier key id
  fails the read as an unknown signing key. Retaining an older key is a
  configuration change this head has not made.

## Why the lease is fenced

The fence is the identity of the claim, not of the task, and it is monotonic per
task under the task lock. A holder whose lease was replaced presents the old
fence and nothing changes: `LEASE_NOT_OWNED` on a superseded or mismatched
fence, `LEASE_EXPIRED` when the lease itself is over. Its report can be retained
separately, but it cannot settle the replacement's work.

Handback and pickup judge lease expiry on the database clock, read once their
locks are held (`lockedInstant`, `clock.ts`), not on `now()`, which is when the
transaction began. A command that waited on a lock past a lease's expiry treats
the lease as expired: handback retains the report and refuses `LEASE_EXPIRED`,
and pickup fences the lease and classifies its hold. A new lease's expiry is
that instant plus the requested seconds, truncated to milliseconds.

Leases end through `endLease` in `recovery.ts`, as `released` or `expired`, and
only a live lease is ended. One already ended keeps the end and the
`released_at` it had.

A runtime invariant that does not hold, such as a statement that must return a
row and returned none, throws `RuntimeInvariantError` (`only.ts`). That is never
a refusal. It aborts the transaction.

A handback names a lease, not a task. The agent envelope reads the task from the
lease before the delegation check (`namedTaskId`,
`commands/agent-authority.ts`), so a handback naming a lease on another task is
outside the one-task purpose and is refused `DELEGATION_OUT_OF_PURPOSE` before
any handback write (matrix case (i),
`tests/acceptance/role-case-matrix.test.ts`). `LEASE_NOT_OWNED` stays the answer
for a stale fence on the agent's own task.

**Superseded work cannot settle.** Proposing a new version retires the
superseded version's live lease and delegation in the same ordered lock set. The
lease is released and the delegation revoked (`lockProposal` and
`proposeUnderLocks`, `propose.ts`; `retireWork`, `recovery.ts`). Under its full
lock set, `handback` then checks that the lease still binds a live version on a
live lineage. If the version was superseded, or the lineage is no longer live,
it keeps the report as `retained`, refuses `LEASE_NOT_OWNED` naming the cause,
and settles nothing (the binding check after the fence checks in `handback`,
`handback.ts`). `tests/runtime/lifecycle-stale-handback.test.ts` holds four
cases, with and without a successor.

**A retired or narrowed agent's late report is still kept** (T4 lines 76 and 78,
runtime review C2, ROOT-NARROWED-REPORT-RULING,
ROOT-GRANT-EXPIRY-INTAKE-RULING). Supersession, cancellation, settlement and
plain expiry leave the original agent's credential answering to no live
delegation, so the agent entry refuses its new handback `DELEGATION_NOT_LIVE`
before `handback` is reached. A narrowed agent's handback answers
`DELEGATION_NARROWED`. The refusal and its status stand, and an evidence-only
intake keeps the report (`retainLateHandback`, `commands/agent-late-handback.ts`).
The credential must name a delegation of this business and this authenticated
agent, and it must be narrowed or no longer live for the reason the refusal
gave:

- For `DELEGATION_NOT_LIVE`, the delegation is revoked, settled or expired
  (`resolveHistoricalDelegation`, `authority/delegations.ts`).
- For `DELEGATION_NARROWED`, there are two cases. In the first, the delegation
  carries an unsettled, unexpired `authority_lost` revocation (R-B), and that
  recorded cause stands (`resolveHistoricalDelegation`). In the second, the
  delegation is still live, but the delegating person's `write` grant covering
  the task has since lapsed, by expiry or otherwise. The intake then runs only
  when `resolveHistoricalDelegation` finds nothing, and it has its own binding
  check. `narrowedOnLease` reads the task from the presented lease, with no
  fallback: a lease outside this business names no task, and nothing is kept.
  `resolveNarrowedDelegation` resolves the credential as live through
  `resolveDelegation`'s own binding (this business, this authenticated agent,
  this credential digest). It then runs `checkDelegatedAuthority` for
  `task.handback`'s collection and action on that task, and returns the
  delegation only when the check answers `DELEGATION_NARROWED`. The check
  reaches that answer only after the decision exclusion, the purpose's
  collection and action, and the one-task ceiling have passed. The caller's
  refusal code is recomputed, never trusted. Nothing is revoked, no
  `authority_lost` cause is written, and the delegation stays live. A lease on
  another task answers `DELEGATION_OUT_OF_PURPOSE` first, because the delegation
  is live, and retains nothing.

The presented lease and fence must then be that delegation's exactly: the lease
names that delegation, this agent holds it, and the fence is the one it was
issued (`retainHistoricalReport`, `handback.ts`). One `retained` row naming the
refusal is appended, beside the refused audit row. No lease, delegation, run,
attempt, reservation, gate, envelope or successor is written, and nothing is
read back to the caller. A wrong lease, fence or credential, another agent's
credential, another business, a heartbeat, any other call and any other refusal
retain nothing. The intake keeps only an otherwise valid report, and one that
reports actual expenditure is not valid. The agent entry refuses a non-null
`actualMinor` `ACTUAL_EXPENDITURE_UNSUPPORTED` 422 among its operands, before
it reads authority (`parseOperands`, `commands/agent-operations.ts`), so that
handback never reaches the intake. A null `actualMinor` is the same request as
none and is kept. A refused or settled handback's replay is answered from its
register row and retains no second row. The same identity with other operands is
`OPERATION_ID_REUSED`, and only a new operation id is a new late report. A fault
after the retained row rolls back the row, the register row and the audit row
together. `tests/runtime/historical-handback-intake.test.ts` holds the retired,
narrowed and grant-expired paths over HTTP, each with a handback carrying
`actualMinor: 1` that retains nothing.

**Both command entries retry once.** The agent entry (`executeAgentCommand`,
`commands/agent-envelope.ts`) and the person entry (`executeCommand`,
`commands/envelope.ts`) share one retry, `retryOnce` in `commands/envelope.ts`,
on the `isRetryableViolation` predicate (`register-store.ts`). The predicate
admits a lost identity claim (`operations_identity_key`), a lost unique-value
claim (`record_unique_values_claim_idx`) and `AffectedSetChanged`. The identity case
is the one an agent reaches. A same-operationId retry in flight behind its
original loses `operations_identity_key` to the original's commit, and its whole
transaction rolls back. The second attempt reads the committed register row and
replays it (DB-PROOF-GAPS-B F1, `tests/runtime/l6-schedules.test.ts` "W02 (b)").

Discover, lock and recheck is one module, `core-runtime/src/rediscovery.ts`.
`lockRediscovered` discovers without locks, takes the complete set in
`LOCK_ORDER`, discovers again and judges the two by the site's rule
(`RecheckRule`): `exact`, or `covered`, where a set that only shrank goes on
(N1). It returns the locks or throws `AffectedSetChanged`, the one type the
person entry retries once. Replay, cancellation (`covered`), authority loss,
`task.propose` and a rejecting `task.decide` (`covered`) use it, and
`grant.revoke` uses its `requireUnchanged` for the dependents it reads inside
the authority-loss classifier. The thermo H6 recheck-rule parameter, deferred
with ARCH candidate 4, is `RecheckRule`; `classifyAll` was already shared.
`tests/runtime/rediscovery-pin.test.ts` pins the statement order at each site.

So `cancelAndClassify`, `classifyAuthorityLoss` and `replayRecordedTransitions`
raise `AffectedSetChanged`, and so do `task.propose`'s live-work recheck
(`lockProposal`, `propose.ts`), a rejecting `task.decide`'s held-set recheck
(`decide.ts`) and `grant.revoke`'s dependent-attempt recheck
(`revokeGrantAsManager`, `commands/authority-controls.ts`). `task.handback`'s
lease-binding recheck (`handback`, `handback.ts`) throws the same type but is
not this pattern: it compares a different read, after the fence verdict. A
propose that meets a pickup of the superseded hold, or a revocation that meets a
handback of a dependent lease, retries once at the person entry. The handback recheck is a
consistency guard that no schedule reaches, because nothing in this head
rewrites the lease's reservation, its version or that version's lineage. It
costs at most one extra attempt, at either entry.
`tests/runtime/retry-gaps.test.ts` holds the three rechecks.

`task.propose` and a rejecting `task.decide` recheck the holds their versions
own under the locks (thermo O3). An approval of the superseded version that
commits between a proposal's discovery and its locks costs one retry, where
before it was an unretried lock-order fault. A rejection's recheck is a
consistency guard, since no command opens a hold on a lineage whose gate is
pending. A rejection racing an approval of the same gate therefore costs one
bounded retry before the same `GATE_ALREADY_DECIDED` answer (F-A4-1, accepted
as is); the recheck right after the locks stays the rule.
`tests/runtime/o3-held-recheck.test.ts` holds both. Of the agent's
`AGENT_SURFACE`, only `task.handback` reaches a thrower. Admitting the type
gives the agent no cancellation authority and adds no command retry at startup.

A second loss reaches the caller as a fault. The person entry then writes one
`failed` audit event in a transaction of its own, which is not a command
attempt. The agent entry writes none. A second `operations_identity_key` loss is
not reachable by a schedule. The retry reads the register by the constraint's
exact key, and the register is append-only, so the retry replays the first
winner. `tests/runtime/retry-bounds.test.ts` forces a person `task.cancel` to
lose its discovery twice and asserts two command attempts, one failed-audit
transaction and nothing committed. Its agent double collision is a staged
control: the test commits and then removes a register row under the append-only
trigger's bypass, a state no schedule produces.

**An abandoned hold is replaced, never revived** (R5). At pickup, a hold that
ended without settling, because its lease expired or the authority behind it was
lost, on a version still approved and current on a live lineage, is replaced by
a fresh hold and a fresh attempt on that version, under the locks the pickup
already holds (`pickup`, `pickup.ts`). The abandoned reservation stays
abandoned. A settled hold, a quarantined one, or a version already holding
elsewhere is refused `RESERVATION_NOT_CLAIMABLE` (`replaceable`).

A stale approval (gate not approved, lineage not live, or version superseded) is
refused before any replacement write, in both the expired-lease and the
abandoned-hold branch (`approvalCurrent` in `planClaim`, `pickup.ts`). It now
outranks the classifier's could-not-release answer and a replacement budget
refusal (thermo O6, lead ruling). Its answer is `RESERVATION_NOT_CLAIMABLE` with
its own reason, "the approval behind this reservation is no longer current"
(`approvalNotCurrent`).

The delegation expires with the lease: `pickup` passes the lease expiry as
`expiresAt`. A delegation outliving its lease would be an agent still holding
narrowed authority over work somebody else now owns. The delegation's expiry is
the lease's and is not clamped to the person's earliest grant expiry
(`mintDelegation`, `authority/delegations.ts`). Between the two, the agent is
narrowed, not ended.

## The successor is part of the settlement

T4: "where approval is required, create the successor proposal/run/step/evidence
pack and pending gate in this same transaction through a lock-aware production
proposal writer", and "a fault rolls back work settlement, accounting release,
successor creation and the success receipt together". Both halves are built.

The writer is `packages/core-runtime/src/proposal-writer.ts`. It holds the
version, run, step, evidence-pack and gate writes once, and `propose` and
`handback` both go through it, so the head has one proposal writer rather than
two that drift. It takes the caller's `LockSet` and opens no transaction: it
calls `LockSet.require` for the task and the lineage. When the task already has
a cap and an envelope that a later decision will bind the version to, it
requires those too. It throws if any is missing. That makes the contract's
"helpers receive the already-held lock context" an argument rather than a
comment. It is also why `handback` can create a successor without the thing T4
forbids: it never calls `propose`, which would check the wrong actor's authority and open a
lock set of its own part-way through a transaction that already holds the lease.

`propose` preallocates the identity of a lineage it is about to open before it
acquires, so the whole set is one ordered call and the lineage lock is never
taken after the reservation locks. T4 calls that "identity preparation, not a
write or approval".

`handback`'s successor input is optional and bounded. Absent is the ordinary
handback, which settles and proposes nothing. Present is refused
`SUCCESSOR_OUT_OF_BOUNDS`, before the first write, unless the ceiling is finite
and positive, fits the room left in the cap behind the envelope, is denominated
in that envelope's currency, and would not be the lineage's third formal round
(G08). The successor is created after the classification, which is the order the
facts come in: the classification is what makes the old attempt nonclaimable,
and the successor is the work somebody may now approve instead. It is not
approved and it opens no hold. A stale fence never reaches it, because those
paths retain their report and return. So a lease that cannot settle work cannot
propose the next of it either. The successor's ceiling is compared with the
cap's remaining room as exact integers (`bigint`) read from SQL text, so the
check holds above 2^53, as the cap's own does
([Why the money is two columns](#why-the-money-is-two-columns)).

**On the command surface.** L3 carries the successor through `task.handback`
(`readSuccessor`, `commands/successor.ts`). The body's `successor` is read
and checked before the runtime is reached, and `proposedByActorId` is not a body
field: the agent actor of the session proposes it. A body that names it under
either spelling is refused `FIELD_NOT_WRITABLE` (`SUCCESSOR_SERVER_OWNED`). The
expiry is `expiresInSeconds`, optional, read through the same `expiryFrom` as
`task.propose`, so it defaults to the same week and has the same seven-day
maximum. A body naming `successor.expiresAt` is refused `FIELD_VALUE_INVALID`.
The result carries the four successor handles, all null when none was asked for.
The body and the refusals are in
[API.md](API.md#the-operations-l4s-runtime-made-possible).
`tests/commands/handback-successor.test.ts` holds the reading of the body with
no database, and the `task.handback and its successor` block in
`tests/api/task-runtime-routes.test.ts` holds it over HTTP. That block covers no
successor, an in-bounds successor committed with the settlement, a body naming
the actor, and `SUCCESSOR_OUT_OF_BOUNDS` settling nothing.

Inside the runtime, `SuccessorRequest` still carries an absolute `expiresAt`.
The command surface computes that instant on the server from `expiresInSeconds`,
so a caller has one spelling, the same as `task.propose`'s.

## What the classifier will not do

`recovery.ts` closes the lifecycle of work that is durably no longer claimable.
It is invoked from inside the authorised operations that write those
transitions, and `classifyUnderLocks` takes no lock of its own because its
caller holds the complete set already.

The classifier revalidates the cause a caller names against the durable rows,
under the locks, before it releases anything: a lineage that is not cancelled does not
support `lineage_cancelled`, and a live lease does not support
`lease_expired_and_fenced`. The release itself is a guarded update that
reports the row it changed, and the envelope subtraction uses that row's own
amount, so a classifier that lost the race writes nothing.

Startup, elapsed time, a missing claimant and `lease_id = null` are not
abandonment triggers. An approved, unleased, currently authorised reservation
stays held across a restart and stays pickupable. The restart proof asserts
that, then asserts that `replayRecordedTransitions` run on that restart returns
an empty list. Only after a recorded terminal transition does
the same call release it, once, with the cause and the cause's identity on the
row.

A `dispatch_marker` or an `observed` attempt always keeps its full hold, as
`quarantined`, even when the work is otherwise terminal, and 0014's trigger
refuses to let either flag be lowered. Work refusal must never erase a real
liability.

### Restart recovery at API startup

TRANSACTION-CONTRACT lines 84 and 92: a first-head restart resumes the same
bounded classifier. An API process start or restart is the resume entry. `main`
in `apps/api/server.ts` awaits `recoverDeployment`
(`apps/api/recovery-entry.ts`) after its dependencies and the delegation
credential keyring are validated and before `serve` binds the port. There is no
database-only reconnect callback: if Postgres restarts under a running API, the
replay runs at the API's next start, and nothing polls.

- **Scope.** `RECOVERY_BUSINESS_KEYS`, from the environment or
  `.local/recovery.env`: comma-separated business keys, de-duplicated, each
  resolved on its own through `createBusinessResolver`, or the literal `none`.
  Unset, blank, an empty entry, an entry holding whitespace, `none` beside a
  key, or a key that resolves to no business stops the start with exit 1 and
  names the setting, before any replay (`parseRecoveryScope`,
  `recoverDeployment`). The literal `none` logs that there are no deployment
  businesses and serves. No request, seed, fixture or scan of
  `public.businesses` supplies the set. The administrative connection runs only
  the key lookups.
- **One transaction per business.** Each business runs
  `database.withBusiness(id, tx => replayRecordedTransitions(tx))` as the
  application role, with the tenant set by `set_config(..., true)` inside that
  transaction, one business after another.
- **Failure.** A failed replay, including `AffectedSetChanged` when discovery
  changed under the classifier's locks (`replayRecordedTransitions`,
  `recovery.ts`), rolls
  that business back. The process exits 1 with
  `restart recovery for business "<key>" rolled back: <reason>`. There is no
  automatic retry: the next normal start runs the replay again in a fresh
  transaction. A business that committed before the failure stays committed
  and has nothing left to replay.
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

- The race is forced. The first transaction is held open on a
  barrier and the second is watched into `wait_event_type = 'Lock'` in
  `pg_stat_activity` before the barrier releases. A run that cannot establish
  the interleaving throws rather than passing quietly. It needs a second
  physical connection, because the fixture's pool is `max: 1` and on one handle
  the second caller queues on the _pool_ and never reaches the gate row.
- The stale fence is asserted twice. The refusal carries the right code, and a
  full snapshot of every reservation, attempt, lease and envelope is compared
  before and after. A refusal that still released a hold passes the first
  assertion and fails the second.
- **Two formal rounds, and no third** (G08): each round is a real
  `request_changes` decision and a real new version, the superseded version's
  gate refuses an approval across the round boundary (G04 holding across
  rounds), and the third round is refused `CHANGE_ROUNDS_EXHAUSTED` with no
  decision row written. The lineage stays live, so approving or rejecting is
  still open. The cap bounds rounds, not the decision.
- **Rejection is terminal** (G05): the rejected gate takes no second decision,
  a new version in the same lineage is refused `LINEAGE_TERMINAL` on the
  lineage rather than on the gate, and the authorised restart is a new lineage
  with a new version and a new pending gate beside the rejected one, never
  over it.
- **The cap's refusal is the cap's** (W05): an approval larger than the cap but
  smaller than its envelope is refused `BUDGET_EXHAUSTED`, not
  `BUDGET_UNAVAILABLE`, and no total moves. The comparison is exact at any
  valid `bigint` limit: a cap above 2^53, filled to the unit, refuses one more
  unit `BUDGET_EXHAUSTED` (`tests/runtime/cap-exact-and-post-lock-clock.test.ts`,
  which also holds the currency refusal and the decide and heartbeat that
  waited on a lock past their deadline). Storage refuses the same over-ceiling
  commit on any path (`budget_caps_ceiling`, migration 0025).
- **The interruption, both ways** (W01): the same production `propose` and
  `decide` calls followed by a throw at the transaction boundary leave a fresh
  connection zero decisions, envelopes, reservations and attempts; committed,
  the same fresh-connection read finds all four and `replayRecordedTransitions`
  has nothing to do.
- **`acquire` sorts, and that is what is observed**: two transactions each list
  cap, envelope and gate in an order the contract forbids, and in different
  wrong orders. `pg_locks` is asked which table the blocked one is parked on,
  and the answer is `budget_caps`, the class `acquire` reached first, although
  the transaction listed the envelope first. With the sort removed from
  `acquire` the same case reports `task_envelopes`, which is the crossing that
  deadlocks. This covers `acquire` in isolation. It does not establish that
  every handler passes `acquire` its complete set, which is a separate property:
  the dcbc8e8 review found recovery bypassing it, and the case below now holds
  that half.
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
  `tests/runtime/decision-abort.test.ts`: an owner-installed trigger shrinks the
  envelope this approval opens, below the hold it is about to take, so
  `decide`'s preflight passes on the cap alone, the signed decision row and the
  approved gate are written, and `reserve` then refuses `BUDGET_UNAVAILABLE`
  under the same locks. The call throws, and a new transaction reads back zero
  decision rows, a still-pending gate, no reservation, no attempt, no envelope
  for that task and unchanged business totals. The trigger rewrites a value
  instead of raising, on purpose: a trigger that raised would abort the
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
  hold on the new version. A successor is work to decide, not work approved. A
  trigger arranged to raise on the successor's version insert, which
  `writeProposal` reaches only after the report, the lease release and the
  classifier have written, leaves neither: no report, no version 2, the lease
  still `live`, the hold still `held`, the run still `claimed` and the envelope
  still carrying the whole hold; with the trigger gone the same handback settles
  and proposes. A successor past the cap, in another currency, at a non-positive
  ceiling, or at a third formal round is refused `SUCCESSOR_OUT_OF_BOUNDS`
  before any write, and the claim is read back live and holding, then settled. A
  stale fence retains its report and creates no successor: the lineage still has
  its one version and its one gate.
- **An expired lease is classified by its owning transaction** (R5): the next
  pickup fences the old lease, the old hold is read back `abandoned` under
  `lease_expired_and_fenced`, a fresh reservation is read back `held` on the
  same still-approved version, and the envelope carries one hold's worth rather
  than two. A second case leaves a fenced lease with an unclassified hold and
  asserts `replayRecordedTransitions` finishes it. Until lane L2-DELEGATION-FIX
  this was unreachable through a command. The delegation expires with the lease
  and `delegations_one_live_per_purpose_idx` does not read expiry, so the spent
  delegation held the slot and the second pickup raised 23505 rather than
  recovering. `mintDelegation` now settles the spent row in the same transaction
  as the fresh hold (AUTHORITY.md, `DELEGATION_ALREADY_LIVE`), so the recovery
  is proved end to end over HTTP as well as in the runtime, with the abandoned
  credential answering `DELEGATION_NOT_LIVE` and the new one working.
- **The schedules go through the command entry** (W01, W03, W05 and the
  heartbeat), in `tests/runtime/schedules-*.test.ts`. The helper cases above
  call `propose` and `handback` directly. These run a person's body through
  `executeCommand` and an agent's through `executeAgentCommand`, the functions
  the HTTP boundary mounts (the header of `schedules-harness.ts`). A third
  connection holds a row the racers need. Each racer starts only once the one
  before it is seen parked in `pg_locks`, and then the holder lets go. The order
  is observed, not slept through. W01 cuts the connection at `COMMIT` with an
  in-test TCP relay, `cutProxy`: once before the server receives the commit and
  once after it commits (`cutProxy`, `schedules-harness.ts`). `connect` defaults
  to a pool of one (`open`, `tenancy/database.ts`), so each racer needs a
  `Database` of its own. Two calls through one `Database` queue in the client and never
  meet in the server.
- Append-only is asserted twice. The application role is refused by privilege,
  and the owner, who does hold `update`, is refused by the trigger. Without the
  second half a later migration granting `update` would make the trail amendable
  without anyone noticing.

## The work controls

The ledger's support controls reach this package through declared operations
([API.md, "The support controls"](API.md#the-support-controls)), never through
direct SQL.

- **Cancellation** is `cancelAndClassify` (`recovery.ts`), reached by
  `task.cancel`. In one transaction under the complete ordered lock set, it
  makes the lineage terminal, releases each live lease on the lineage, revokes
  the delegation each lease was issued under, ends `planned` and `claimed` runs
  as `cancelled`, and classifies the lineage's own holds. The delegation's
  recorded cause is `work_retired` (`retireWork`). A run already handed back
  keeps that state. The cancelled agent's next call answers
  `DELEGATION_NOT_LIVE`, and the same agent can pick up a restarted lineage
  (`tests/runtime/lifecycle-cancel.test.ts`). A handback that commits between
  discovery and the locks leaves a smaller set, and the cancellation goes on
  with it (`tests/runtime/lifecycle-cancel-race.test.ts`). A set that grew
  because a pickup committed its lease in between rolls back with nothing
  written and raises `AffectedSetChanged`. Recovery replay and authority loss
  raise it on any change to their set. The person command entry retries it once,
  in a fresh transaction that discovers again (`isRetryableViolation`,
  `register-store.ts`), so the first request answers with the applied cancel
  (`tests/runtime/cancel-rediscover.test.ts`). A second loss reaches the caller
  as a fault, with one `failed` audit event
  (`tests/runtime/retry-bounds.test.ts`). Startup recovery does not retry: a
  changed set there fails the start.
- **Authority** for `task.cancel` and `task.restart` is `write` on the task
  named in `recordId`, so a record-scoped writer controls its own lineage
  (`authorisedOn: 'record'` in `COMMAND_SURFACE`, `commands/surface.ts`;
  `tests/commands/control-scope.test.ts`). `task.pickup`, `task.heartbeat` and
  `task.handback` are authorised as `write` on the task their reservation or
  lease belongs to (`authorisedOn: 'claim'`, the same file), the scope the
  runtime and `grant.revoke` ask under their locks. A record-scoped writer works
  their own lease on that task. An id that resolves to nothing is asked at
  business scope, so a foreign and a fabricated id get the same answer
  (`SCOPE_OF.claim`, `commands/prepare.ts`).
- **Authority loss** is classified by the revocation that caused it.
  `grant.revoke` and `delegation.revoke` end in `classifyAuthorityLoss`
  (`recovery.ts`, called from `revokeGrantAsManager` and
  `revokeDelegationAsManager` in `commands/authority-controls.ts`). Work
  authority for a claim is `write` on the task collection, the action
  `task.pickup`, `task.heartbeat` and `task.handback` are declared under. Losing
  `read` or `comment` does not end a claim (`dependents`,
  `authority-controls.ts`). Under the ordered lock set:
  - An agent's attempt that lost its work authority has its delegation revoked,
    its live lease released and its holds classified `authority_revoked`, with
    the delegation as the recorded cause. The delegation's `revocation_cause` is
    `authority_lost`, written in the same transaction (`classifyAuthorityLoss`,
    migration 0023). The agent's next call on its still unexpired credential
    answers `DELEGATION_NARROWED`, and nothing is reactivated.
  - `grant.revoke` also ends a person's own lease. When the revoked grant, or
    one it issued, was the holder's `write` on the task collection, through
    their person or actor subject, and no other live `write` covers the task,
    the same transaction releases the lease and classifies its hold
    `authority_revoked`, with the grant id as the recorded cause (`personLeases`
    in `revokeGrantAsManager`).
  - The recheck after the revocation asks `write` at record scope on the task
    (`stillAuthorised`). A holder whose business-wide `write` is revoked while a
    record-scoped `write` on the task remains keeps the lease, and can renew and
    hand it back. So does an attempt whose person still holds `write` through
    another grant.
  - Each run whose claim ended goes back to `planned`, not to a terminal state
    (`reopenRuns`, `recovery.ts`). The abandoned hold is never revived: a
    claimant with current authority gets a fresh hold and attempt
    ([Why the lease is fenced](#why-the-lease-is-fenced)).
  - Both revocations answer with `detail.classifiedHolds`: the ids of the
    reservations the revocation classified, and nothing else about them
    (`classifiedHolds`, `authority-controls.ts`).
  - A marked or observed attempt keeps its full hold as `quarantined`.

  `replayRecordedTransitions` also finds a revocation that committed without its
  classification (`discoverEligible`, `recovery.ts`). Its production caller is
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
  presents the lease's own delegation. A person renews their own delegation-free
  lease under their current `write` on the task (`checkAuthority` in
  `heartbeat`). A lease that is not live, is past its instant, or whose
  delegation is settled, revoked or expired is `LEASE_EXPIRED` and is not
  revived. Expiry, the delegation's liveness and the renewal are all judged on
  one `clock_timestamp()` read taken after the lease and delegation locks
  (`lockedInstant`, `core-runtime/src/clock.ts`), so a heartbeat that waited
  past the expiry is refused and revives nothing. One renewal reaches at most
  `MAXIMUM_RENEWAL_SECONDS` (3600) past that instant and never past
  `MAXIMUM_LEASE_LIFETIME_SECONDS` (8 hours) after the pickup's `acquired_at`.
  It never shortens a lease. The delegation's expiry is copied from the lease
  row. No timer grants authority. Nothing runs on its own, a lease that stops
  beating expires, and the next pickup fences it as before. Bounded unstarted
  recovery stays the owning operations' classifier (W04), reached by pickup,
  cancellation and restart replay, with no sweeper added.
- **Open on the heartbeat.** The two bounds, 1 hour a beat and 8 hours in total,
  are lane constants (`MAXIMUM_RENEWAL_SECONDS` and
  `MAXIMUM_LEASE_LIFETIME_SECONDS`, `heartbeat.ts`), not an owner policy. They
  are lane L3-CONTROLS's choice and await root or owner confirmation. The 8-hour
  total is enforced in SQL as
  `greatest(expires_at, least(instant + renewal, acquired_at + 8 hours))`,
  where `instant` is the clock read after the locks (the renewal's `update` in
  `heartbeat`). So past it a beat keeps `expires_at` and never extends it.
  `tests/runtime/schedules-heartbeat.test.ts` reaches the boundary by moving
  the lease's `acquired_at` back on the database clock, then beats through
  `task.heartbeat`.

## The delegation credential key

An agent's pickup returns its delegation credential once, and the delegation
keeps only its digest. So that a lost pickup response can be answered again, the
credential is derived rather than drawn. It is HMAC-SHA256 over
`["ops-astro/delegation-credential/v1", keyId, businessId, agentActorId, delegationId]`
under a dedicated delegation credential key
(`credentialEncoding`, `authority/credential-keys.ts:83-91`; minted in
`mintDelegation`, `authority/delegations.ts`).

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
- **A missing or malformed key.** A keyring that is malformed or half configured
  stops the API at boot with the reason, never the bytes (the `credentialKeys`
  check in `main`, `apps/api/server.ts`). An agent `task.pickup` without a
  usable keyring refuses `DEPENDENCY_NOT_LANDED` before claiming anything
  (`pickupReservation`, `commands/tasks-pickup.ts`). A replay whose delegation
  names a key this process does not hold answers `DEPENDENCY_NOT_LANDED`
  `['task.pickup', 'delegation credential key <id>']`. A derived token whose
  digest does not match answers `DEPENDENCY_NOT_LANDED`
  `['task.pickup', 'delegation credential integrity']`. Neither rewrites the
  receipt or mints a replacement (`replayPickup`,
  `commands/agent-replay.ts`).

**The pickup replay.** A lost pickup response is retried with the identical
operation id and body and no delegation credential. It returns the original
handles and the same credential only while the delegation is live, the
delegating person's grants still cover the purpose, and the receipt's lease,
reservation, attempt and approved version are still bound, live and current.
Otherwise it gives the current refusal (`DELEGATION_NOT_LIVE`,
`DELEGATION_NARROWED`, `LEASE_NOT_OWNED`, `LEASE_EXPIRED`,
`RESERVATION_NOT_CLAIMABLE`) and no receipt content (`replayPickup`,
`commands/agent-replay.ts`). The register keeps the handles with a null
credential (`storable`).

**The legacy limit.** Delegations minted before migration 0022 are
`credential_scheme = 'legacy-random'`. Their random credentials cannot be
recovered from their SHA-256 digests. Tokens already delivered stay valid. A
lost response on a legacy pickup replays its handles with `credential: null` and
`CREDENTIAL_NOT_REPLAYED` (`replayPickup`). Recovery is `task.cancel`, or a new
pickup once the old lease has expired. No migration or code path relabels a
legacy row as derivable, and 0022's trigger forbids it.

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
  `task.heartbeat` are routed there, and its codes are registered, with their
  statuses, in `commands/register.ts`
  ([API.md](API.md#the-operations-l4s-runtime-made-possible)).
- **No operation-identity replay.** `propose` and `decide` take no
  `operationId`; replay is L3's envelope, which already owns that mechanism for
  every other command. The register is their repeat-request identity, so a
  proposal sent twice under one `operationId` replays the first answer rather
  than opening a second lineage.
- **No audit writer.** `core-runtime` writes no `audit_events` row.
  `envelope.ts` audits every success and every refusal around the runtime
  handlers, including the loser of a decision race (G03): a
  `GATE_ALREADY_DECIDED` refusal leaves the same row as any refused attempt.
- **A refusal rolls back, and never raises.** A returned runtime refusal must
  not commit what its handler touched on the way. `attemptWork`'s savepoint
  rolls it back, and the refusal travels out as a value. An exception would
  take the transaction and the audit row with it.
- **The caller names none of the server's facts.** The actor, the person, the
  subjects, the signing key, the cap and the authorising person are the
  server's. The payloads carry what a proposal is, never who makes it. The
  handlers are `tasks-propose.ts`, `tasks-decide.ts`, `tasks-pickup.ts`,
  `tasks-handback.ts` and `tasks-lease.ts` in `commands/`, imported directly.
- **Restart (W06) is tested outside this package, and not yet closed.** Every
  case here is a transaction boundary and a fresh connection to a server that
  never stopped.
  `pnpm verify:restart` restarts a declared, disposable Postgres and the API
  process and compares the lineage, gate, decision, reservation, lease,
  attempt, delegation, receipt and register identities with their states. It
  then drives replays, the handback, a gate that lapsed while nothing ran and a
  Request Changes round over HTTP against the new process, and cancels and
  restarts a lineage there through the declared `task.cancel` and
  `task.restart`. The browser leg (B6) carries a gate, lease and attempt across
  a restart on a lane stack; its run at the integrated candidate is pending.
  The coverage table and the open items are in `docs/local/PROOFS.md`.
- **No full cover for a decision on read.** On v1 and v2 rows the round,
  decision time, lineage, acting identity, id, sequence and previous link are
  covered at most by the unkeyed link. U1 does not see a newest decision removed
  together with its gate's outcome. The read's resolver knows one signing key
  ([A decision is verified before a read returns it](#a-decision-is-verified-before-a-read-returns-it)).
- **No replay outside API startup.** The owning operations classify their own
  transitions. `replayRecordedTransitions` runs in production only when an API
  process starts. Nothing polls, and a Postgres restart under a running API
  waits for the API's next start
  ([Restart recovery at API startup](#restart-recovery-at-api-startup)).
- **No settlement of actual expenditure.** `handback` refuses any non-null
  `actualMinor` (R6). This head dispatches nothing, so it observes nothing it
  could settle. The settlement path, with its own proofs, belongs to the later
  authorised, evidence-backed accounting work.
