// SPDX-License-Identifier: AGPL-3.0-only
//
// T3: the queue projection, and pickup.
//
// `queue` is a read and not a grant. It projects approved, held, unleased
// reservations on live lineages, and it projects nothing an agent could not
// already ask for — being in the queue is not permission to pick it up, which
// is re-established under the locks in `pickup`.
//
// The claimant is a person or an agent, and both claim through the one
// transaction below: the same approval, budget, lock order, lease, fence and
// idempotency. What differs is only where the claimant's authority comes from.
// T3 line 66: "Person pickup uses the same work/lease contract without
// pretending the person is an agent."
//
// - **Agent.** `pickup` mints the delegation through `mintDelegation`
//   with `expiresAt` equal to the lease expiry, so the agent's authority and
//   its claim on the work end at the same instant. A delegation outliving its
//   lease is an agent still holding narrowed authority over work somebody else
//   now owns.
// - **Person.** The holder is the verified person's own actor, and the
//   authority is that person's own live grants, re-read under the locks. No
//   delegation is minted and no credential is returned: a delegation whose
//   agent is really a person is the collapse the agent path exists to prevent.
//
// The coordinator's recorded decision: minting checks the **delegating
// person's** business-scope grants, which is the authority module's
// conservative reading. An agent cannot choose the person, widen the purpose or
// mint from a bare assignment; `authorisedByPersonId` is the person who
// authorised this work and `mintedByActorId` is their acting identity, never
// the agent's.

import { randomUUID } from 'node:crypto';
import { mintDelegation, refuseCommand } from '../../core-records/src/index.ts';
import type { TenantQuery, MintedDelegation, Subject } from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import { leaseReason, nextFence, personWriteLive } from './lease-ownership.ts';
import type { LockRequest, LockSet } from './locks.ts';
import { only } from './only.ts';
import { reserve } from './decide.ts';
import { checkAuthorityAt, classifyUnderLocks, endLease, holdCoveringGrants } from './recovery.ts';
import { lockRediscovered } from './rediscovery.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export interface QueueEntry {
  readonly reservationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly versionId: string;
  readonly lineageId: string;
  readonly purpose: string;
  readonly heldMinor: number;
}

/**
 * Approved, held, unpicked. A reservation bound to a lease is out, a terminal
 * lineage is out, and an attempt carrying a dispatch marker or an observation
 * is out — the last because T5 quarantines it with its hold retained, and a
 * quarantined attempt must not be handed to a worker as ordinary work.
 */
export async function queue(tx: TenantQuery): Promise<readonly QueueEntry[]> {
  const rows = await tx.query<{
    readonly reservation_id: string;
    readonly task_id: string;
    readonly run_id: string;
    readonly version_id: string;
    readonly lineage_id: string;
    readonly purpose: string;
    readonly held_minor: string;
  }>(
    `select res.id as reservation_id, run.task_id, run.id as run_id, res.version_id,
            lin.id as lineage_id, ver.purpose, res.held_minor::text as held_minor
       from public.reservations res
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       -- A trashed task's work is not handed out.
       join public.records task on task.business_id = run.business_id and task.id = run.task_id
                               and task.deleted_at is null
      where res.business_id = $1
        and res.state = 'held'
        and res.lease_id is null
        and g.state = 'approved'
        and lin.state = 'live'
        and ver.superseded_at is null
        and att.state = 'reserved'
        and not att.dispatch_marker
        and not att.observed
      order by res.created_at`,
    [tx.businessId],
  );
  return rows.map((row) => ({
    reservationId: row.reservation_id,
    taskId: row.task_id,
    runId: row.run_id,
    versionId: row.version_id,
    lineageId: row.lineage_id,
    purpose: row.purpose,
    heldMinor: Number(row.held_minor),
  }));
}

interface PickupCommon {
  readonly reservationId: string;
  /** The person whose approval is the recorded work authorisation. Named by the decision, not by the claimant. */
  readonly authorisedByPersonId: string;
  readonly collection: string;
  readonly leaseSeconds: number;
}

export interface AgentPickupRequest extends PickupCommon {
  readonly claimant: 'agent';
  readonly agentActorId: string;
  /** The approving person's acting identity. The delegation's ceiling is their live grants. */
  readonly mintedByActorId: string;
}

export interface PersonPickupRequest extends PickupCommon {
  readonly claimant: 'person';
  /** The verified session's person and actor, never a body field. */
  readonly personId: string;
  readonly actorId: string;
}

export type PickupRequest = AgentPickupRequest | PersonPickupRequest;

interface PickedUpCommon {
  readonly leaseId: string;
  readonly fence: number;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly versionId: string;
  readonly expiresAt: Date;
  /** The person whose approval authorised this work, kept apart from whoever claimed it. */
  readonly authorisedByPersonId: string;
  readonly holderActorId: string;
  /** What this head cannot do, stated rather than left to be discovered. */
  readonly declaredIncompleteness: readonly string[];
  /** T1-R8: the brief, the expected versions and the budget envelope, in the one call. */
  readonly brief: { readonly taskId: string; readonly purpose: string };
  readonly expectedVersions: { readonly versionId: string; readonly taskRevision: number };
  readonly budgetEnvelope: {
    readonly envelopeId: string;
    readonly currency: string;
    readonly heldMinor: number;
  };
}

export interface PickedUp extends PickedUpCommon {
  readonly claimant: 'agent';
  readonly delegation: MintedDelegation;
}

export interface PickedUpByPerson extends PickedUpCommon {
  readonly claimant: 'person';
}

export const DECLARED_INCOMPLETENESS: readonly string[] = [
  'No step is dispatched: this head exports no effect dispatch and no provider adapter.',
  'The attempt is synthetic and names no provider or model.',
  'Handback records a local outcome. It settles no provider usage.',
];

/**
 * The one answer for a reservation this caller may not claim, whichever reason
 * it is: none by that id, none approved, or one another holder already has.
 * It never names the holding lease, which would tell a caller with no claim
 * on the work whose claim it was. The command layer
 * answers the fabricated and foreign forms with these same two sentences.
 */
export const NOT_CLAIMABLE_REASON =
  'Name a reservation from task.queue: approved, held and not already picked up.';
export const NOT_CLAIMABLE_FIX =
  'A reservation with no approval behind it is not work anybody authorised.';

/** Who the claim's authority is read from, as grant subjects. */
/** A live lease on the task, with the held reservation bound to it when there is one. */
interface TaskLease {
  readonly lease_id: string;
  readonly reservation_id: string | null;
  readonly envelope_id: string | null;
  readonly cap_id: string | null;
  readonly run_id: string | null;
  readonly lineage_id: string | null;
}

/** The lease, and everything classifying its hold touches. `acquire` sorts it. */
function taskLeaseLocks(row: TaskLease): readonly LockRequest[] {
  const lease: LockRequest = { lockClass: 'lease', id: row.lease_id };
  if (
    row.reservation_id === null ||
    row.envelope_id === null ||
    row.cap_id === null ||
    row.run_id === null ||
    row.lineage_id === null
  ) {
    return [lease];
  }
  return [
    { lockClass: 'cap', id: row.cap_id },
    { lockClass: 'envelope', id: row.envelope_id },
    { lockClass: 'run', id: row.run_id },
    { lockClass: 'lineage', id: row.lineage_id },
    lease,
    { lockClass: 'reservation', id: row.reservation_id },
  ];
}

function authoritySubjects(request: PickupRequest): readonly Subject[] {
  return request.claimant === 'person'
    ? [
        { kind: 'person', id: request.personId },
        { kind: 'actor', id: request.actorId },
      ]
    : [
        { kind: 'person', id: request.authorisedByPersonId },
        { kind: 'actor', id: request.mintedByActorId },
      ];
}

export async function pickup(
  tx: TenantQuery,
  request: AgentPickupRequest,
): Promise<RuntimeResult<PickedUp>>;
export async function pickup(
  tx: TenantQuery,
  request: PersonPickupRequest,
): Promise<RuntimeResult<PickedUpByPerson>>;
export async function pickup(
  tx: TenantQuery,
  request: PickupRequest,
): Promise<RuntimeResult<PickedUp | PickedUpByPerson>> {
  const found = await findClaim(tx, request.reservationId);
  // A reservation on a trashed task is answered exactly
  // as one that does not exist, as a trashed task is to its readers: the same
  // two sentences the command layer gives for an unknown reservation, so the
  // answer says nothing about what was there. Restore brings the work back.
  if (found === undefined)
    return refuse('RESERVATION_NOT_CLAIMABLE', NOT_CLAIMABLE_REASON, NOT_CLAIMABLE_FIX);
  const { locks, found: taskLeases } = await lockClaim(tx, request, found);

  // `now()` is when this transaction began, and a
  // pickup that waited on these locks past a lease's expiry would still read
  // that lease as live and refuse the replacement. The clock read here, after
  // the locks, is the one instant every lease-expiry decision below and the new
  // lease's own expiry use.
  const lockedAt = await lockedInstant(tx);
  const rechecked = await recheckClaim(tx, request.reservationId, lockedAt);
  if (!rechecked.ok) return rechecked;
  const { state, plan } = rechecked.value;

  const claimed = await claimHold(tx, request.reservationId, found, state, plan, locks);
  if (!claimed.ok) return claimed;
  const fenced = await fenceLiveLease(tx, found.task_id, taskLeases, locks, lockedAt);
  if (fenced !== null) return fenced;

  // From the database instant above, not the process clock. Whole
  // milliseconds, so the `Date` the delegation is minted with and the lease
  // column hold the same instant.
  const expiry = await tx.query<{ readonly at: Date }>(
    `select date_trunc('milliseconds', $1::timestamptz + make_interval(secs => $2)) as at`,
    [lockedAt, request.leaseSeconds],
  );
  const expiresAt = only(expiry, 'pickup: the new lease expiry').at;
  const authorised = await authoriseClaimant(tx, request, found, expiresAt, lockedAt);
  if (!authorised.ok) return authorised;
  const delegation = authorised.value;

  const lease = await writeLease(tx, request, found, claimed.value, delegation, expiresAt);
  return await answer(tx, request, found, claimed.value, lease, delegation);
}

/** What discovery found behind the reservation, before any lock. */
interface Found {
  readonly envelope_id: string;
  readonly version_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly lineage_id: string;
  readonly purpose: string;
  readonly lease_id: string | null;
  readonly cap_id: string;
  readonly step_id: string;
}

/** Find: the reservation and every row the claim touches, on a task not in the trash. */
async function findClaim(tx: TenantQuery, reservationId: string): Promise<Found | undefined> {
  const discovered = await tx.query<Found>(
    `select res.envelope_id, res.version_id, res.run_id, res.lease_id, env.cap_id,
            run.task_id, run.lineage_id, step.id as step_id, ver.purpose
       from public.reservations res
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.planned_steps step on step.business_id = res.business_id and step.run_id = run.id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.records task on task.business_id = run.business_id and task.id = run.task_id
                               and task.deleted_at is null
      where res.business_id = $1 and res.id = $2
      order by step.ordinal limit 1`,
    [tx.businessId, reservationId],
  );
  return discovered[0];
}

/**
 * Lock: the claimant's covering grants for share, then the complete set.
 *
 * The task's live lease may be another reservation's,
 * and if it has expired this pickup fences it. Fencing it is the transition
 * that makes that lease's hold nonclaimable, so the hold is classified here
 * too (R5), which needs its reservation, run, lineage and accounting parents
 * in this set rather than reached for afterwards.
 *
 * R5. The cap is in the set because a replacement hold reads its committed
 * total, and the reservation's own lease is in it because that is the lease
 * this transaction may have to fence. Discovering either of them after the
 * reservation lock would be the backwards acquisition the contract forbids.
 * A lease that appears between discovery and the locks needs a lock not
 * held and rolls back as `AffectedSetChanged`; one that ended goes on (N1).
 */
async function lockClaim(
  tx: TenantQuery,
  request: PickupRequest,
  found: Found,
): Promise<{ readonly locks: LockSet; readonly found: readonly TaskLease[] }> {
  await holdCoveringGrants(tx, authoritySubjects(request), request.collection);
  return await lockRediscovered(tx, {
    discover: async () =>
      await tx.query<TaskLease>(
        `select l.id as lease_id, res.id as reservation_id, res.envelope_id, env.cap_id,
                run.id as run_id, run.lineage_id
           from public.leases l
           left join public.reservations res
             on res.business_id = l.business_id and res.lease_id = l.id
            and res.state = 'held' and res.id <> $3
           left join public.task_envelopes env
             on env.business_id = res.business_id and env.id = res.envelope_id
           left join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
          where l.business_id = $1 and l.task_id = $2 and l.state = 'live'
          order by l.id, res.id`,
        [tx.businessId, found.task_id, request.reservationId],
      ),
    locks: (leases) => [
      { lockClass: 'cap', id: found.cap_id },
      { lockClass: 'envelope', id: found.envelope_id },
      { lockClass: 'task', id: found.task_id },
      { lockClass: 'run', id: found.run_id },
      { lockClass: 'lineage', id: found.lineage_id },
      ...(found.lease_id === null ? [] : [{ lockClass: 'lease' as const, id: found.lease_id }]),
      { lockClass: 'reservation', id: request.reservationId },
      ...leases.flatMap(taskLeaseLocks),
    ],
    rule: 'covered',
    changed:
      'pickup: the live leases on the task changed under discovery; roll back and rediscover rather than extending the lock set',
  });
}

/** Re-check, under the locks: everything above was discovery. */
async function recheckClaim(
  tx: TenantQuery,
  reservationId: string,
  lockedAt: string,
): Promise<RuntimeResult<{ readonly state: ClaimState; readonly plan: ClaimPlan }>> {
  const claimable = await tx.query<ClaimState>(
    `select res.state, res.lease_id, res.held_minor::text as held_minor, run.state as run_state,
            exists (select 1 from public.handback_reports hr
                     where hr.business_id = res.business_id and hr.reservation_id = res.id
                       and hr.disposition = 'settled') as settled,
            exists (select 1 from public.reservations o
                     where o.business_id = res.business_id and o.version_id = res.version_id
                       and o.id <> res.id and o.state in ('held', 'quarantined')) as active_elsewhere,
            g.state as gate_state, lin.state as lineage_state,
            (ver.superseded_at is not null) as superseded,
            att.id as attempt_id, att.state as attempt_state,
            (att.dispatch_marker or att.observed) as marked,
            bound.state as bound_lease_state,
            (bound.expires_at <= $3::timestamptz) as bound_lease_expired
       from public.reservations res
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       left join public.leases bound on bound.business_id = res.business_id and bound.id = res.lease_id
       join public.records task on task.business_id = run.business_id and task.id = run.task_id
                               and task.deleted_at is null
      where res.business_id = $1 and res.id = $2`,
    [tx.businessId, reservationId, lockedAt],
  );
  const state = claimable[0];
  // Gone, or its task trashed while this waited on the task lock: the same
  // answer as a reservation that never existed (#10).
  if (state === undefined)
    return refuse('RESERVATION_NOT_CLAIMABLE', NOT_CLAIMABLE_REASON, NOT_CLAIMABLE_FIX);
  const plan = planClaim(state, reservationId);
  if (plan.kind === 'refuse') return plan.refusal;
  return { ok: true, value: { state, plan } };
}

/**
 * Write the hold this claim works. R5: the owning transaction does the whole
 * expired-lease lifecycle. It fences the old lease and classifies the old hold
 * under the locks it already holds. The abandoned reservation is never
 * revived; a replacement is a new row with a new attempt, on the
 * still-approved version.
 */
async function claimHold(
  tx: TenantQuery,
  reservationId: string,
  found: Found,
  state: ClaimState,
  plan: ClaimPlan,
  locks: LockSet,
): Promise<RuntimeResult<{ readonly reservationId: string; readonly attemptId: string }>> {
  const expiredLeaseId = plan.kind === 'replace' ? plan.fence : null;
  if (expiredLeaseId !== null) {
    await endLease(tx, expiredLeaseId, 'expired');
    const classified = await classifyUnderLocks(
      tx,
      { reservationId, cause: 'lease_expired_and_fenced', causeId: expiredLeaseId },
      locks,
    );
    if (!classified.released) {
      return refuse(
        'RESERVATION_NOT_CLAIMABLE',
        `the hold behind this reservation's expired lease could not be released: ${classified.reason}`,
        'A retained or quarantined hold goes to its recorded owner, not to a worker.',
      );
    }
  }
  if (plan.kind === 'fresh') {
    return { ok: true, value: { reservationId, attemptId: state.attempt_id } };
  }
  return await reserve(tx, {
    envelopeId: found.envelope_id,
    versionId: found.version_id,
    runId: found.run_id,
    stepId: found.step_id,
    heldMinor: Number(state.held_minor),
  });
}

/**
 * Never steal a live lease. An expired one is fenced out by the new fence
 * rather than deleted, so a late report from it can still be retained. Read
 * live under the task lock, so the guard in `endLease` changes nothing here.
 * Its hold is classified in this transaction, under the locks taken for it,
 * rather than left counted until a restart replay finds it. A marked hold
 * is quarantined by the classifier and stays with its
 * recorded owner; this pickup goes on.
 */
async function fenceLiveLease(
  tx: TenantQuery,
  taskId: string,
  taskLeases: readonly TaskLease[],
  locks: LockSet,
  lockedAt: string,
): Promise<RuntimeResult<never> | null> {
  const held = await tx.query<{ readonly id: string; readonly expired: boolean }>(
    `select id, (expires_at <= $3::timestamptz) as expired from public.leases
      where business_id = $1 and task_id = $2 and state = 'live'`,
    [tx.businessId, taskId, lockedAt],
  );
  const current = held[0];
  if (current === undefined) return null;
  if (!current.expired) {
    return refuse(
      'LEASE_HELD',
      leaseReason('held'),
      'Wait for it to be handed back, or for it to expire.',
    );
  }
  await endLease(tx, current.id, 'expired');
  for (const row of taskLeases) {
    if (row.lease_id !== current.id || row.reservation_id === null) continue;
    // eslint-disable-next-line no-await-in-loop
    await classifyUnderLocks(
      tx,
      { reservationId: row.reservation_id, cause: 'lease_expired_and_fenced', causeId: current.id },
      locks,
    );
  }
  return null;
}

/**
 * Authorise the claimant, under the locks (T3 lines 62-64). A person: their
 * own live grants on this task, and nobody else's -- not the approver's, and
 * not a body's choice. The approval is the recorded authorisation and was
 * checked above; this is the claimant's authority. At the locked instant
 * a grant that lapsed while this waited on the
 * cap does not count.
 *
 * An agent: the delegation expires with the lease, minted against the
 * delegating person's live grants, which `mintDelegation` reads for itself;
 * nothing is copied here. `purposeScope` is R5's one-task ceiling.
 * `mintDelegation` reads the delegating person's grants through `now()`, the
 * transaction's start, so they are judged here first at the locked instant,
 * with `mintDelegation`'s own refusal, and a grant that lapsed mints nothing.
 */
async function authoriseClaimant(
  tx: TenantQuery,
  request: PickupRequest,
  found: Found,
  expiresAt: Date,
  lockedAt: string,
): Promise<RuntimeResult<MintedDelegation | undefined>> {
  if (request.claimant === 'person') {
    const person = { subjects: authoritySubjects(request), collection: request.collection };
    if (!(await personWriteLive(tx, person, found.task_id, lockedAt))) {
      return refuse(
        'SCOPE_NOT_GRANTED',
        'no live grant of yours covers work on this task',
        'Ask a manager for write on this task, or leave it for a holder who has it.',
      );
    }
    return { ok: true, value: undefined };
  }
  const actions = ['read', 'comment', 'write'] as const;
  for (const action of actions) {
    // Sequential, as the authority module's own check is: one transaction,
    // one connection.
    // oxlint-disable-next-line no-await-in-loop
    const delegable = await checkAuthorityAt(
      tx,
      [{ kind: 'person', id: request.authorisedByPersonId }],
      { collection: request.collection, action, scope: { kind: 'business', id: null } },
      lockedAt,
    );
    if (!delegable.ok) {
      return {
        ok: false,
        refusal: refuseCommand(
          'DELEGATION_WIDENS',
          [],
          [
            `the delegating person holds no live ${action} grant on ${request.collection}`,
            'narrow the purpose, or grant the person that authority first',
          ],
        ),
      };
    }
  }
  const minted = await mintDelegation(tx, {
    agentActorId: request.agentActorId,
    delegatePersonId: request.authorisedByPersonId,
    mintedByActorId: request.mintedByActorId,
    purpose: found.purpose,
    collections: [request.collection],
    actions: [...actions],
    expiresAt,
    purposeScope: { kind: 'record', id: found.task_id },
  });
  if (!minted.ok) return { ok: false, refusal: minted.refusal };
  return { ok: true, value: minted.value };
}

interface NewLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly holderActorId: string;
  readonly expiresAt: Date;
}

/** Write the lease at the task's next fence, and bind the hold, attempt and run to it once. */
async function writeLease(
  tx: TenantQuery,
  request: PickupRequest,
  found: Found,
  claimed: { readonly reservationId: string; readonly attemptId: string },
  delegation: MintedDelegation | undefined,
  expiresAt: Date,
): Promise<NewLease> {
  const fence = await nextFence(tx, found.task_id);
  const holderActorId = request.claimant === 'person' ? request.actorId : request.agentActorId;
  const leaseId = randomUUID();
  await tx.query(
    `insert into public.leases
       (business_id, id, task_id, run_id, reservation_id, delegation_id, holder_actor_id,
        authorised_by_person_id, fence, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tx.businessId,
      leaseId,
      found.task_id,
      found.run_id,
      claimed.reservationId,
      delegation?.delegation.id ?? null,
      holderActorId,
      request.authorisedByPersonId,
      fence,
      expiresAt,
    ],
  );
  // Bound once. The reservation stays `held`; binding is a claim, not a spend.
  await tx.query(
    `update public.reservations set lease_id = $3
      where business_id = $1 and id = $2 and lease_id is null`,
    [tx.businessId, claimed.reservationId, leaseId],
  );
  await tx.query(
    `update public.attempts set state = 'dispatched', lease_id = $3
      where business_id = $1 and id = $2 and state = 'reserved'`,
    [tx.businessId, claimed.attemptId, leaseId],
  );
  await tx.query(
    `update public.planned_runs set state = 'claimed' where business_id = $1 and id = $2`,
    [tx.businessId, found.run_id],
  );
  return { leaseId, fence, holderActorId, expiresAt };
}

/** The claim's handles and brief, as the holder is handed them. */
async function answer(
  tx: TenantQuery,
  request: PickupRequest,
  found: Found,
  claimed: { readonly reservationId: string; readonly attemptId: string },
  lease: NewLease,
  delegation: MintedDelegation | undefined,
): Promise<RuntimeResult<PickedUp | PickedUpByPerson>> {
  const context = await tx.query<{
    readonly revision: string;
    readonly currency: string;
    readonly held_minor: string;
  }>(
    `select r.revision::text as revision,
            env.currency, res.held_minor::text as held_minor
       from public.reservations res
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.records r on r.business_id = res.business_id and r.id = $3
      where res.business_id = $1 and res.id = $2`,
    [tx.businessId, claimed.reservationId, found.task_id],
  );
  const facts = only(context, "pickup: the new hold's task, envelope and reservation");
  const common: PickedUpCommon = {
    leaseId: lease.leaseId,
    fence: lease.fence,
    reservationId: claimed.reservationId,
    attemptId: claimed.attemptId,
    taskId: found.task_id,
    runId: found.run_id,
    versionId: found.version_id,
    expiresAt: lease.expiresAt,
    authorisedByPersonId: request.authorisedByPersonId,
    holderActorId: lease.holderActorId,
    declaredIncompleteness: DECLARED_INCOMPLETENESS,
    brief: { taskId: found.task_id, purpose: found.purpose },
    expectedVersions: { versionId: found.version_id, taskRevision: Number(facts.revision) },
    budgetEnvelope: {
      envelopeId: found.envelope_id,
      currency: facts.currency,
      heldMinor: Number(facts.held_minor),
    },
  };
  return delegation === undefined
    ? { ok: true, value: { ...common, claimant: 'person' } }
    : { ok: true, value: { ...common, claimant: 'agent', delegation } };
}

/** The claimable reservation as re-read under the locks. */
interface ClaimState {
  readonly state: string;
  readonly lease_id: string | null;
  readonly gate_state: string;
  readonly lineage_state: string;
  readonly superseded: boolean;
  readonly attempt_id: string;
  readonly attempt_state: string;
  readonly marked: boolean;
  readonly bound_lease_state: string | null;
  readonly bound_lease_expired: boolean | null;
  readonly held_minor: string;
  readonly run_state: string;
  readonly settled: boolean;
  readonly active_elsewhere: boolean;
}

/**
 * What the claim does with the reservation it read, decided before anything
 * is written: claim the hold as it stands, replace it, or refuse. A
 * replacement's `fence` names the expired lease to fence and classify first,
 * and is null when the old hold was already classified and only needs a new
 * one beside it.
 */
type ClaimPlan =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'replace'; readonly fence: string | null }
  | { readonly kind: 'refuse'; readonly refusal: RuntimeResult<never> };

/**
 * R5. The expired-lease lifecycle starts at the first replacement below. A
 * reservation with a non-null `lease_id` is not refused until this branch has
 * asked whether that lease expired; refused first, the old identity would
 * never be fenced and its hold never classified, and the only other expiry
 * branch applies to a *different* unleased reservation on the same task. The
 * replacement is a fresh hold on
 * the still-approved version, which 0019 permits, because one active hold per
 * version is the accepted rule and one hold ever was not. Its approval is
 * checked here, before the caller writes anything.
 *
 * R5, the remainder. A hold that ended without settling -- the authority
 * behind its lease was lost, and replay classified it -- leaves approved work
 * on a live lineage that nothing now holds. It is never revived; the claim
 * gets a fresh hold and a fresh attempt on the still-approved version, under
 * the locks already held, exactly as the expired-lease replacement does.
 * Settled work is not replaceable: a handback that abandoned its hold because
 * nothing was spent still finished the work.
 */
function planClaim(state: ClaimState, reservationId: string): ClaimPlan {
  if (state.marked) {
    return {
      kind: 'refuse',
      refusal: refuse(
        'RESERVATION_NOT_CLAIMABLE',
        `attempt ${state.attempt_id} carries a dispatch marker or an observation and is quarantined`,
        'A marked attempt keeps its hold and goes to the recorded reconciliation owner, not to a worker.',
      ),
    };
  }
  if (state.state === 'held' && state.lease_id !== null) {
    if (state.bound_lease_state === 'live' && state.bound_lease_expired !== true) {
      return {
        kind: 'refuse',
        refusal: refuse('RESERVATION_NOT_CLAIMABLE', NOT_CLAIMABLE_REASON, NOT_CLAIMABLE_FIX),
      };
    }
    // Asked before the fence, the classification and
    // the replacement hold write, as it is for every other branch.
    if (!approvalCurrent(state)) return { kind: 'refuse', refusal: approvalNotCurrent() };
    return { kind: 'replace', fence: state.lease_id };
  }
  const replacing = state.state === 'abandoned' && replaceable(state);
  if (state.state !== 'held' && !replacing) {
    return {
      kind: 'refuse',
      refusal: refuse(
        'RESERVATION_NOT_CLAIMABLE',
        `reservation ${reservationId} is ${state.state}`,
        'A terminal reservation is never revived. Replacement work gets a fresh attempt.',
      ),
    };
  }
  if (!approvalCurrent(state)) return { kind: 'refuse', refusal: approvalNotCurrent() };
  return replacing ? { kind: 'replace', fence: null } : { kind: 'fresh' };
}

/** The version is the live one, its gate approved and its lineage live. */
function approvalCurrent(state: ClaimState): boolean {
  return state.gate_state === 'approved' && state.lineage_state === 'live' && !state.superseded;
}

function approvalNotCurrent(): RuntimeResult<never> {
  return refuse(
    'RESERVATION_NOT_CLAIMABLE',
    'the approval behind this reservation is no longer current',
    'Re-read the queue. A superseded or terminal approval authorises nothing.',
  );
}

/** An abandoned hold whose work was never settled and whose run is still open. */
function replaceable(state: {
  readonly run_state: string;
  readonly settled: boolean;
  readonly marked: boolean;
  readonly active_elsewhere: boolean;
}): boolean {
  // One active hold per version (0019): a version already holding elsewhere is
  // claimed through that hold, from the queue, and not through this one.
  return (
    !state.settled &&
    !state.marked &&
    !state.active_elsewhere &&
    (state.run_state === 'claimed' || state.run_state === 'planned')
  );
}
