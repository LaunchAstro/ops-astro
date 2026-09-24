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
// - **Agent.** `pickup` mints the delegation through L2's `mintDelegation`
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
// person's** business-scope grants, which is L2's conservative reading. An
// agent cannot choose the person, widen the purpose or mint from a bare
// assignment; `authorisedByPersonId` is the person who authorised this work
// and `mintedByActorId` is their acting identity, never the agent's.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import {
  mintDelegation,
  type MintedDelegation,
} from '../../core-records/src/authority/delegations.ts';
import { checkAuthority, type Subject } from '../../core-records/src/authority/grants.ts';
import { lockedInstant } from './clock.ts';
import { acquire } from './locks.ts';
import { only } from './only.ts';
import { reserve } from './decide.ts';
import { classifyUnderLocks, endLease } from './recovery.ts';
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
 * The last used to name the holding lease, which told a caller with no claim
 * on the work whose claim it was (IDENT-AUDIT red 3). The command layer
 * answers the fabricated and foreign forms with these same two sentences.
 */
export const NOT_CLAIMABLE_REASON =
  'Name a reservation from task.queue: approved, held and not already picked up.';
export const NOT_CLAIMABLE_FIX =
  'A reservation with no approval behind it is not work anybody authorised.';

/** Who the claim's authority is read from, as grant subjects. */
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

/**
 * The revocation race (RUNTIME-LIFECYCLE F4 residual). `grant.revoke` takes
 * `for update` on the grant row before any runtime lock, then rediscovers the
 * live leases its loss affects. A pickup that read the grant before that
 * revocation and committed after its rediscovery was a live claim nobody
 * classified. Holding `for share` on every grant the claim's authority could
 * rest on -- the subjects' own grants in this collection and each grant they
 * descend from -- makes the two serialise: a revocation that locked first is
 * seen by the authority read below, and one that locks second waits for this
 * pickup to commit and then finds its lease.
 *
 * It is taken before the runtime set, where `grant.revoke` takes its own, so
 * neither side ever waits on a grant row while holding a runtime lock.
 */
async function holdCoveringGrants(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: string,
): Promise<void> {
  await tx.query(
    `with recursive chain as (
       select g.id, g.parent_grant_id from public.grants g
        where g.business_id = $1 and g.collection = $2
          and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                       where s.kind = g.subject_kind and s.id = g.subject_id)
       union
       select p.id, p.parent_grant_id from public.grants p
         join chain c on p.id = c.parent_grant_id
        where p.business_id = $1
     )
     select g.id from public.grants g
      where g.business_id = $1 and g.id in (select id from chain)
      order by g.id
      for share`,
    [
      tx.businessId,
      collection,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
    ],
  );
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
  const discovered = await tx.query<{
    readonly envelope_id: string;
    readonly version_id: string;
    readonly run_id: string;
    readonly task_id: string;
    readonly lineage_id: string;
    readonly purpose: string;
    readonly lease_id: string | null;
    readonly cap_id: string;
    readonly step_id: string;
  }>(
    `select res.envelope_id, res.version_id, res.run_id, res.lease_id, env.cap_id,
            run.task_id, run.lineage_id, step.id as step_id, ver.purpose
       from public.reservations res
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.planned_steps step on step.business_id = res.business_id and step.run_id = run.id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
      where res.business_id = $1 and res.id = $2
      order by step.ordinal limit 1`,
    [tx.businessId, request.reservationId],
  );
  const found = discovered[0];
  if (found === undefined) {
    return refuse(
      'RESERVATION_NOT_CLAIMABLE',
      `no reservation ${request.reservationId} in this business`,
      'Read the queue and pick up something on it.',
    );
  }

  const live = await tx.query<{ readonly id: string }>(
    `select id from public.leases
      where business_id = $1 and task_id = $2 and state = 'live'`,
    [tx.businessId, found.task_id],
  );

  await holdCoveringGrants(tx, authoritySubjects(request), request.collection);

  // R5. The cap is in the set because a replacement hold reads its committed
  // total, and the reservation's own lease is in it because that is the lease
  // this transaction may have to fence. Discovering either of them after the
  // reservation lock would be the backwards acquisition the contract forbids.
  const locks = await acquire(tx, [
    { lockClass: 'cap', id: found.cap_id },
    { lockClass: 'envelope', id: found.envelope_id },
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'run', id: found.run_id },
    { lockClass: 'lineage', id: found.lineage_id },
    ...(live[0] === undefined ? [] : [{ lockClass: 'lease' as const, id: live[0].id }]),
    ...(found.lease_id === null ? [] : [{ lockClass: 'lease' as const, id: found.lease_id }]),
    { lockClass: 'reservation', id: request.reservationId },
  ]);

  // Sol 6 RUNTIME-1 (158d6de): `now()` is when this transaction began, and a
  // pickup that waited on these locks past a lease's expiry would still read
  // that lease as live and refuse the replacement. The clock read here, after
  // the locks, is the one instant every lease-expiry decision below and the new
  // lease's own expiry use.
  const lockedAt = await lockedInstant(tx);

  // Re-read under the locks. Everything above was discovery.
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
      where res.business_id = $1 and res.id = $2`,
    [tx.businessId, request.reservationId, lockedAt],
  );
  const state = claimable[0];
  if (state === undefined) {
    return refuse(
      'RESERVATION_NOT_CLAIMABLE',
      'the reservation vanished under the lock',
      'Re-read the queue.',
    );
  }
  const plan = planClaim(state, request.reservationId);
  if (plan.kind === 'refuse') return plan.refusal;
  const expiredLeaseId = plan.kind === 'replace' ? plan.fence : null;

  // R5. The owning transaction does the whole expired-lease lifecycle. It
  // fences the old lease and classifies the old hold under the locks it
  // already holds; the replacement hold is opened below.
  if (expiredLeaseId !== null) {
    await endLease(tx, expiredLeaseId, 'expired');
    const classified = await classifyUnderLocks(
      tx,
      {
        reservationId: request.reservationId,
        cause: 'lease_expired_and_fenced',
        causeId: expiredLeaseId,
      },
      locks,
    );
    if (!classified.released) {
      return refuse(
        'RESERVATION_NOT_CLAIMABLE',
        `the hold behind lease ${expiredLeaseId} could not be released: ${classified.reason}`,
        'A retained or quarantined hold goes to its recorded owner, not to a worker.',
      );
    }
  }
  // The abandoned reservation is never revived; a replacement is a new row
  // with a new attempt, on the still-approved version.
  const claimed: RuntimeResult<{ readonly reservationId: string; readonly attemptId: string }> =
    plan.kind === 'fresh'
      ? { ok: true, value: { reservationId: request.reservationId, attemptId: state.attempt_id } }
      : await reserve(tx, {
          envelopeId: found.envelope_id,
          versionId: found.version_id,
          runId: found.run_id,
          stepId: found.step_id,
          heldMinor: Number(state.held_minor),
        });
  if (!claimed.ok) return claimed;
  const { reservationId, attemptId } = claimed.value;

  // Never steal a live lease. An expired one is fenced out by the new fence
  // below rather than deleted, so a late report from it can still be retained.
  const held = await tx.query<{ readonly id: string; readonly expired: boolean }>(
    `select id, (expires_at <= $3::timestamptz) as expired from public.leases
      where business_id = $1 and task_id = $2 and state = 'live'`,
    [tx.businessId, found.task_id, lockedAt],
  );
  const current = held[0];
  if (current !== undefined) {
    if (!current.expired) {
      return refuse(
        'LEASE_HELD',
        `another live lease owns the work on task ${found.task_id}`,
        'Wait for it to be handed back, or for it to expire.',
      );
    }
    // Read live just above under the task lock, so the guard in `endLease`
    // changes nothing here.
    await endLease(tx, current.id, 'expired');
  }

  // From the database instant above, not the process clock. Whole
  // milliseconds, so the `Date` the delegation is minted with and the lease
  // column hold the same instant.
  const expiry = await tx.query<{ readonly at: Date }>(
    `select date_trunc('milliseconds', $1::timestamptz + make_interval(secs => $2)) as at`,
    [lockedAt, request.leaseSeconds],
  );
  const expiresAt = only(expiry, 'pickup: the new lease expiry').at;

  // The claimant's authority, read under the locks (T3 lines 62-64).
  let delegation: MintedDelegation | undefined;
  if (request.claimant === 'person') {
    // The person's own live grants on this task, and nobody else's: not the
    // approver's, and not a body's choice. The approval is the recorded
    // authorisation and was checked above; this is the claimant's authority.
    const granted = await checkAuthority(tx, authoritySubjects(request), {
      collection: request.collection,
      action: 'write',
      scope: { kind: 'record', id: found.task_id },
    });
    if (!granted.ok) {
      return refuse(
        'SCOPE_NOT_GRANTED',
        'no live grant of yours covers work on this task',
        'Ask a manager for write on this task, or leave it for a holder who has it.',
      );
    }
  } else {
    // The delegation expires with the lease. Minted against the delegating
    // person's live grants, which L2 reads for itself; nothing is copied here.
    // `purposeScope` is R5's one-task ceiling (coordinator addendum 1): L2
    // owns the field (0016) and refuses a call outside that one record.
    const minted = await mintDelegation(tx, {
      agentActorId: request.agentActorId,
      delegatePersonId: request.authorisedByPersonId,
      mintedByActorId: request.mintedByActorId,
      purpose: found.purpose,
      collections: [request.collection],
      actions: ['read', 'comment', 'write'],
      expiresAt,
      purposeScope: { kind: 'record', id: found.task_id },
    });
    if (!minted.ok) return { ok: false, refusal: minted.refusal };
    delegation = minted.value;
  }

  // Monotonic per task, computed under the task lock. A sequence would be
  // shared across tenants; this is per task and unique by index.
  const fences = await tx.query<{ readonly next: string }>(
    `select coalesce(max(fence), 0) + 1 as next from public.leases
      where business_id = $1 and task_id = $2`,
    [tx.businessId, found.task_id],
  );
  const fence = Number(fences[0]?.next ?? 1);

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
      reservationId,
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
    [tx.businessId, reservationId, leaseId],
  );
  await tx.query(
    `update public.attempts set state = 'dispatched', lease_id = $3
      where business_id = $1 and id = $2 and state = 'reserved'`,
    [tx.businessId, attemptId, leaseId],
  );
  await tx.query(
    `update public.planned_runs set state = 'claimed' where business_id = $1 and id = $2`,
    [tx.businessId, found.run_id],
  );

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
    [tx.businessId, reservationId, found.task_id],
  );
  const facts = only(context, "pickup: the new hold's task, envelope and reservation");
  const common: PickedUpCommon = {
    leaseId,
    fence,
    reservationId,
    attemptId,
    taskId: found.task_id,
    runId: found.run_id,
    versionId: found.version_id,
    expiresAt,
    authorisedByPersonId: request.authorisedByPersonId,
    holderActorId,
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
 * R5. The expired-lease lifecycle starts at the first replacement below,
 * because this was the branch that made it unreachable: a reservation with a
 * non-null `lease_id` refused before anything looked at whether that lease had
 * expired, so the old identity was never fenced, its hold was never
 * classified, and the only expiry branch in the file applied to a *different*
 * unleased reservation on the same task. The replacement is a fresh hold on
 * the still-approved version, which 0019 permits, because one active hold per
 * version is the accepted rule and one hold ever was not. Its approval is
 * checked here, before the caller writes anything (thermo O6).
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
    // Thermo O6, lead ruling: asked before the fence, the classification and
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
