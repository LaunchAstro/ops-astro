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
//   answer `handback` gives a stale holder.
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
import { acquire } from './locks.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** One renewal's reach, the same ceiling a pickup's own lease has. */
export const MAXIMUM_RENEWAL_SECONDS: number = 60 * 60;
/** How long one pickup's lease may be kept alive by heartbeats, in total. */
export const MAXIMUM_LEASE_LIFETIME_SECONDS: number = 8 * 60 * 60;

export interface HeartbeatRequest {
  readonly leaseId: string;
  readonly fence: number;
  /** The agent actor the session resolved, never a body field. */
  readonly holderActorId: string;
  /** The delegation the credential resolved to, never a body field. */
  readonly delegationId: string;
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
  request: HeartbeatRequest,
): Promise<RuntimeResult<Renewed>> {
  const notOwned = refuse(
    'LEASE_NOT_OWNED',
    `lease ${request.leaseId} is not this caller's at fence ${request.fence}`,
    'Renew the lease this pickup issued, at the fence it handed back.',
  );
  const found = await tx.query<{ readonly delegation_id: string | null }>(
    `select delegation_id from public.leases where business_id = $1 and id = $2`,
    [tx.businessId, request.leaseId],
  );
  if (found[0] === undefined) return notOwned;

  await acquire(tx, [
    { lockClass: 'lease', id: request.leaseId },
    { lockClass: 'delegation', id: request.delegationId },
  ]);

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
            (l.expires_at <= now()) as expired,
            (select max(fence) from public.leases
              where business_id = l.business_id and task_id = l.task_id)::text as current_fence,
            exists (select 1 from public.delegations d
                     where d.business_id = l.business_id and d.id = l.delegation_id
                       and d.revoked_at is null and d.settled_at is null
                       and d.expires_at > now()) as delegation_live
       from public.leases l where l.business_id = $1 and l.id = $2`,
    [tx.businessId, request.leaseId],
  );
  const lease = leases[0];
  if (
    lease === undefined ||
    lease.holder_actor_id !== request.holderActorId ||
    lease.delegation_id !== request.delegationId ||
    Number(lease.fence) !== request.fence ||
    lease.fence !== lease.current_fence
  ) {
    return notOwned;
  }
  if (lease.state !== 'live' || lease.expired || !lease.delegation_live) {
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
              least(now() + make_interval(secs => $3),
                    acquired_at + make_interval(secs => $4)))
      where business_id = $1 and id = $2 and state = 'live'
      returning expires_at`,
    [tx.businessId, request.leaseId, request.renewSeconds, MAXIMUM_LEASE_LIFETIME_SECONDS],
  );
  const expiresAt = (renewed[0] as { readonly expires_at: Date }).expires_at;
  // Copied from the lease row in SQL, not through the `Date` above, which
  // keeps milliseconds where the column keeps microseconds.
  await tx.query(
    `update public.delegations d set expires_at = l.expires_at
       from public.leases l
      where d.business_id = $1 and d.id = $2 and d.revoked_at is null and d.settled_at is null
        and l.business_id = $1 and l.id = $3`,
    [tx.businessId, request.delegationId, request.leaseId],
  );

  return {
    ok: true,
    value: { leaseId: request.leaseId, taskId: lease.task_id, fence: request.fence, expiresAt },
  };
}
