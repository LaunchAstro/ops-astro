// SPDX-License-Identifier: AGPL-3.0-only
//
// The lease heartbeat: the current owner renews its own lease, within a
// bounded lifetime, and nobody else can.
//
// Contract ledger: "Lease heartbeat / bounded unstarted recovery — current
// lease owner for heartbeat ... lease renewal within permitted lifetime ... no
// timer grants authority, no general provider sweeper". So:
//
// - **Owner only.** The caller is the lease's holder, presenting the very
//   delegation the pickup minted with it, at the lease's fence, and that fence
//   is still the task's newest. Anything else is `LEASE_NOT_OWNED`, the same
//   answer `handback` gives a stale holder. A person's own lease has no
//   delegation, so a person presents none and an agent's lease is never theirs
//   (EX-01): the delegation on the lease must be exactly the one presented,
//   and absent on both sides for a person.
// - **Live only.** A lease that is released, expired or past its instant is
//   `LEASE_EXPIRED` and is not revived: renewal extends a live claim, it never
//   makes a new one. A settled, revoked or expired delegation is refused by the
//   agent envelope before this runs and again here under the lock.
// - **Bounded.** One renewal reaches at most `MAXIMUM_RENEWAL_SECONDS` past
//   now, and no renewal reaches past `MAXIMUM_LEASE_LIFETIME_SECONDS` after
//   the pickup. It never shortens a lease. The delegation moves with the lease,
//   because the pickup minted them to end together.
// - **No timer.** Nothing here runs on its own. Recovery of unstarted work is
//   still the owning operations' classifier (`recovery.ts`), reached by
//   pickup, cancellation and restart replay; a lease that stops beating simply
//   expires, and the next pickup fences it as it always did (W04).

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import type { Subject } from '../../core-records/src/authority/grants.ts';
import { checkAuthorityAt } from './recovery.ts';
import { lockedInstant } from './clock.ts';
import { acquire } from './locks.ts';
import { only } from './only.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** One renewal's reach, the same ceiling a pickup's own lease has. */
export const MAXIMUM_RENEWAL_SECONDS: number = 60 * 60;
/** How long one pickup's lease may be kept alive by heartbeats, in total. */
export const MAXIMUM_LEASE_LIFETIME_SECONDS: number = 8 * 60 * 60;

export interface HeartbeatRequest {
  readonly claimant: 'agent';
  readonly leaseId: string;
  readonly fence: number;
  /** The agent actor the session resolved, never a body field. */
  readonly holderActorId: string;
  /** The delegation the credential resolved to, never a body field. */
  readonly delegationId: string;
  readonly renewSeconds: number;
}

/**
 * A person renewing the lease their own pickup took. There is no delegation
 * to present because none was minted: the person's authority is their own
 * live grants, re-read here under the lease lock, so a person whose write was
 * revoked since the pickup renews nothing.
 */
export interface PersonHeartbeatRequest {
  readonly claimant: 'person';
  readonly leaseId: string;
  readonly fence: number;
  /** The verified session's actor, never a body field. */
  readonly holderActorId: string;
  /** The session's own grant subjects: its person and its actor. */
  readonly subjects: readonly Subject[];
  readonly collection: string;
  readonly renewSeconds: number;
}

export interface Renewed {
  readonly leaseId: string;
  readonly taskId: string;
  readonly fence: number;
  readonly expiresAt: Date;
}

export async function heartbeat(
  tx: TenantQuery,
  request: HeartbeatRequest | PersonHeartbeatRequest,
): Promise<RuntimeResult<Renewed>> {
  const delegationId = request.claimant === 'person' ? null : request.delegationId;
  // A constant reason: the presented lease and fence are not echoed, so a
  // foreign, a fabricated and a same-business lease answer in the same bytes
  // (root ruling 2).
  const notOwned = refuse(
    'LEASE_NOT_OWNED',
    "the named lease is not this caller's at the presented fence",
    'Renew the lease this pickup issued, at the fence it handed back.',
  );
  const found = await tx.query<{ readonly delegation_id: string | null }>(
    `select delegation_id from public.leases where business_id = $1 and id = $2`,
    [tx.businessId, request.leaseId],
  );
  if (found[0] === undefined) return notOwned;

  await acquire(tx, [
    { lockClass: 'lease', id: request.leaseId },
    ...(delegationId === null ? [] : [{ lockClass: 'delegation' as const, id: delegationId }]),
  ]);

  // Sol 6 RUNTIME-3: `now()` is when this transaction began, and a heartbeat
  // that waited on the lease lock past the expiry would still see the lease
  // live. The clock read here, after the locks, is the one instant the expiry,
  // the delegation's liveness and the renewal below all use.
  const lockedAt = await lockedInstant(tx);

  const leases = await tx.query<{
    readonly task_id: string;
    readonly state: string;
    readonly fence: string;
    readonly holder_actor_id: string;
    readonly delegation_id: string | null;
    readonly expired: boolean;
    readonly current_fence: string;
    readonly delegation_live: boolean;
  }>(
    `select l.task_id, l.state, l.fence::text as fence, l.holder_actor_id, l.delegation_id,
            (l.expires_at <= $3::timestamptz) as expired,
            (select max(fence) from public.leases
              where business_id = l.business_id and task_id = l.task_id)::text as current_fence,
            exists (select 1 from public.delegations d
                     where d.business_id = l.business_id and d.id = l.delegation_id
                       and d.revoked_at is null and d.settled_at is null
                       and d.expires_at > $3::timestamptz) as delegation_live
       from public.leases l where l.business_id = $1 and l.id = $2`,
    [tx.businessId, request.leaseId, lockedAt],
  );
  const lease = leases[0];
  if (
    lease === undefined ||
    lease.holder_actor_id !== request.holderActorId ||
    lease.delegation_id !== delegationId ||
    Number(lease.fence) !== request.fence ||
    lease.fence !== lease.current_fence
  ) {
    return notOwned;
  }
  // A person's lease carries no delegation, so its liveness is the person's
  // own current authority instead, and losing it is the same answer.
  const authorityLive =
    request.claimant === 'person'
      ? // At the locked instant (final review R2-RUNTIME-4).
        (
          await checkAuthorityAt(
            tx,
            request.subjects,
            {
              collection: request.collection,
              action: 'write',
              scope: { kind: 'record', id: lease.task_id },
            },
            lockedAt,
          )
        ).ok
      : lease.delegation_live;
  if (!authorityLive && request.claimant === 'person' && lease.state === 'live' && !lease.expired) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      `no live grant of yours covers work on task ${lease.task_id} any more`,
      'A lease is renewed under current rights. Ask a manager for write on this task.',
    );
  }
  if (lease.state !== 'live' || lease.expired || !authorityLive) {
    return refuse(
      'LEASE_EXPIRED',
      `lease ${request.leaseId} is ${lease.expired ? 'past its expiry' : lease.state}; a heartbeat renews a live lease and never revives one`,
      'Pick the work up again if it is still claimable.',
    );
  }

  const renewed = await tx.query<{ readonly expires_at: Date }>(
    `update public.leases
        set expires_at = greatest(
              expires_at,
              least($5::timestamptz + make_interval(secs => $3),
                    acquired_at + make_interval(secs => $4)))
      where business_id = $1 and id = $2 and state = 'live'
      returning expires_at`,
    [
      tx.businessId,
      request.leaseId,
      request.renewSeconds,
      MAXIMUM_LEASE_LIFETIME_SECONDS,
      lockedAt,
    ],
  );
  const expiresAt = only(renewed, 'heartbeat: the live lease renewed above').expires_at;
  // Copied from the lease row in SQL, not through the `Date` above, which
  // keeps milliseconds where the column keeps microseconds.
  if (delegationId === null) {
    return {
      ok: true,
      value: { leaseId: request.leaseId, taskId: lease.task_id, fence: request.fence, expiresAt },
    };
  }
  await tx.query(
    `update public.delegations d set expires_at = l.expires_at
       from public.leases l
      where d.business_id = $1 and d.id = $2 and d.revoked_at is null and d.settled_at is null
        and l.business_id = $1 and l.id = $3`,
    [tx.businessId, delegationId, request.leaseId],
  );

  return {
    ok: true,
    value: { leaseId: request.leaseId, taskId: lease.task_id, fence: request.fence, expiresAt },
  };
}
