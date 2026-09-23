// SPDX-License-Identifier: AGPL-3.0-only
//
// T3: the queue projection, and pickup.
//
// `queue` is a read and not a grant. It projects approved, held, unleased
// reservations on live lineages, and it projects nothing an agent could not
// already ask for — being in the queue is not permission to pick it up, which
// is re-established under the locks in `pickup`.
//
// `pickup` mints the delegation through L2's `mintDelegation` with `expiresAt`
// equal to the lease expiry, so the agent's authority and its claim on the
// work end at the same instant. A delegation outliving its lease is an agent
// still holding narrowed authority over work somebody else now owns.
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
  type DelegationDecision,
  type MintedDelegation,
  type MintRequest,
} from '../../core-records/src/authority/delegations.ts';
import { acquire } from './locks.ts';
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

export interface PickupRequest {
  readonly reservationId: string;
  readonly agentActorId: string;
  /** The person whose live grants are the ceiling. Named by the authorisation, not by the agent. */
  readonly authorisedByPersonId: string;
  readonly mintedByActorId: string;
  readonly collection: string;
  readonly leaseSeconds: number;
}

export interface PickedUp {
  readonly leaseId: string;
  readonly fence: number;
  readonly delegation: MintedDelegation;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly versionId: string;
  readonly expiresAt: Date;
  /** What this head cannot do, stated rather than left to be discovered. */
  readonly declaredIncompleteness: readonly string[];
}

export const DECLARED_INCOMPLETENESS: readonly string[] = [
  'No step is dispatched: this head exports no effect dispatch and no provider adapter.',
  'The attempt is synthetic and names no provider or model.',
  'Handback records a local outcome. It settles no provider usage.',
];

/**
 * The one-task purpose ceiling (coordinator addendum 1).
 *
 * R5 is "R1's delegated agent, purpose-scoped to one task", and the accepted
 * shape is a mandatory `purposeScope` on `MintRequest` naming the picked-up
 * task's record id. Lane L2-FIX owns the producer — the field on `MintRequest`
 * and `Delegation`, the two columns on `public.delegations` in its migration
 * `0015_*`, and the extra `DELEGATION_OUT_OF_PURPOSE` refusal when a call's
 * scope is not exactly that record. None of that is this lane's to write.
 *
 * L2-FIX landed the field (migration 0016), so the request below is a plain
 * `MintRequest` and this adapter only names the pin it satisfies; the call
 * site passes the field as it always did.
 */
async function mintForOneTask(
  tx: TenantQuery,
  request: MintRequest,
): Promise<DelegationDecision<MintedDelegation>> {
  return await mintDelegation(tx, request);
}

export async function pickup(
  tx: TenantQuery,
  request: PickupRequest,
): Promise<RuntimeResult<PickedUp>> {
  const discovered = await tx.query<{
    readonly envelope_id: string;
    readonly version_id: string;
    readonly run_id: string;
    readonly task_id: string;
    readonly lineage_id: string;
    readonly purpose: string;
  }>(
    `select res.envelope_id, res.version_id, res.run_id, run.task_id, run.lineage_id, ver.purpose
       from public.reservations res
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
      where res.business_id = $1 and res.id = $2`,
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

  await acquire(tx, [
    { lockClass: 'envelope', id: found.envelope_id },
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'run', id: found.run_id },
    { lockClass: 'lineage', id: found.lineage_id },
    ...(live[0] === undefined ? [] : [{ lockClass: 'lease' as const, id: live[0].id }]),
    { lockClass: 'reservation', id: request.reservationId },
  ]);

  // Re-read under the locks. Everything above was discovery.
  const claimable = await tx.query<{
    readonly state: string;
    readonly lease_id: string | null;
    readonly gate_state: string;
    readonly lineage_state: string;
    readonly superseded: boolean;
    readonly attempt_id: string;
    readonly attempt_state: string;
    readonly marked: boolean;
  }>(
    `select res.state, res.lease_id, g.state as gate_state, lin.state as lineage_state,
            (ver.superseded_at is not null) as superseded,
            att.id as attempt_id, att.state as attempt_state,
            (att.dispatch_marker or att.observed) as marked
       from public.reservations res
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
      where res.business_id = $1 and res.id = $2`,
    [tx.businessId, request.reservationId],
  );
  const state = claimable[0];
  if (state === undefined) {
    return refuse(
      'RESERVATION_NOT_CLAIMABLE',
      'the reservation vanished under the lock',
      'Re-read the queue.',
    );
  }
  if (state.marked) {
    return refuse(
      'RESERVATION_NOT_CLAIMABLE',
      `attempt ${state.attempt_id} carries a dispatch marker or an observation and is quarantined`,
      'A marked attempt keeps its hold and goes to the recorded reconciliation owner, not to a worker.',
    );
  }
  if (state.state !== 'held' || state.lease_id !== null) {
    return refuse(
      'RESERVATION_NOT_CLAIMABLE',
      `reservation ${request.reservationId} is ${state.state}${state.lease_id === null ? '' : ' and already claimed'}`,
      'A terminal reservation is never revived. Replacement work gets a fresh attempt.',
    );
  }
  if (state.gate_state !== 'approved' || state.lineage_state !== 'live' || state.superseded) {
    return refuse(
      'RESERVATION_NOT_CLAIMABLE',
      'the approval behind this reservation is no longer current',
      'Re-read the queue. A superseded or terminal approval authorises nothing.',
    );
  }

  // Never steal a live lease. An expired one is fenced out by the new fence
  // below rather than deleted, so a late report from it can still be retained.
  const held = await tx.query<{ readonly id: string; readonly expired: boolean }>(
    `select id, (expires_at <= now()) as expired from public.leases
      where business_id = $1 and task_id = $2 and state = 'live'`,
    [tx.businessId, found.task_id],
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
    await tx.query(
      `update public.leases set state = 'expired', released_at = now()
        where business_id = $1 and id = $2`,
      [tx.businessId, current.id],
    );
  }

  const expiresAt = new Date(Date.now() + request.leaseSeconds * 1000);

  // The delegation expires with the lease. Minted against the delegating
  // person's live grants, which L2 reads for itself; nothing is copied here.
  const minted = await mintForOneTask(tx, {
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

  // Monotonic per task, computed under the task lock. A sequence would be
  // shared across tenants; this is per task and unique by index.
  const fences = await tx.query<{ readonly next: string }>(
    `select coalesce(max(fence), 0) + 1 as next from public.leases
      where business_id = $1 and task_id = $2`,
    [tx.businessId, found.task_id],
  );
  const fence = Number(fences[0]?.next ?? 1);

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
      request.reservationId,
      minted.value.delegation.id,
      request.agentActorId,
      request.authorisedByPersonId,
      fence,
      expiresAt,
    ],
  );

  // Bound once. The reservation stays `held`; binding is a claim, not a spend.
  await tx.query(
    `update public.reservations set lease_id = $3
      where business_id = $1 and id = $2 and lease_id is null`,
    [tx.businessId, request.reservationId, leaseId],
  );
  await tx.query(
    `update public.attempts set state = 'dispatched', lease_id = $3
      where business_id = $1 and id = $2 and state = 'reserved'`,
    [tx.businessId, state.attempt_id, leaseId],
  );
  await tx.query(
    `update public.planned_runs set state = 'claimed' where business_id = $1 and id = $2`,
    [tx.businessId, found.run_id],
  );

  return {
    ok: true,
    value: {
      leaseId,
      fence,
      delegation: minted.value,
      reservationId: request.reservationId,
      attemptId: state.attempt_id,
      taskId: found.task_id,
      runId: found.run_id,
      versionId: found.version_id,
      expiresAt,
      declaredIncompleteness: DECLARED_INCOMPLETENESS,
    },
  };
}
