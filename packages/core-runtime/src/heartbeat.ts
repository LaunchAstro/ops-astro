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

import type { TenantQuery, Subject } from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import {
  fenceCause,
  holdsLease,
  LEASE_FIXES,
  personWriteLive,
  readLease,
  refuseLease,
  type LeaseClaimant,
} from './lease-ownership.ts';
import { acquire } from './locks.ts';
import { only } from './only.ts';
import type { RuntimeResult } from './refusals.ts';

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
  // Find: a lease this business does not hold is answered as one the caller
  // does not own, before any lock.
  const found = await tx.query<{ readonly delegation_id: string | null }>(
    `select delegation_id from public.leases where business_id = $1 and id = $2`,
    [tx.businessId, request.leaseId],
  );
  if (found[0] === undefined) return refuseLease('not_owned', LEASE_FIXES.heartbeat.notOwned);

  await acquire(tx, [
    { lockClass: 'lease', id: request.leaseId },
    ...(delegationId === null ? [] : [{ lockClass: 'delegation' as const, id: delegationId }]),
  ]);

  // Sol 6 RUNTIME-3: `now()` is when this transaction began, and a heartbeat
  // that waited on the lease lock past the expiry would still see the lease
  // live. The clock read here, after the locks, is the one instant the expiry,
  // the delegation's liveness and the renewal below all use.
  const lockedAt = await lockedInstant(tx);
  const checked = await recheckOwner(tx, request, lockedAt);
  if (!checked.ok) return checked;
  const expiresAt = await renew(tx, request, delegationId, lockedAt);
  return {
    ok: true,
    value: { leaseId: request.leaseId, taskId: checked.value, fence: request.fence, expiresAt },
  };
}

/**
 * Re-check, under the locks: the caller holds this lease at its current
 * fence, and the lease and the authority behind it are still live. Answers
 * the task the lease works.
 */
async function recheckOwner(
  tx: TenantQuery,
  request: HeartbeatRequest | PersonHeartbeatRequest,
  lockedAt: string,
): Promise<RuntimeResult<string>> {
  const lease = await readLease(tx, request.leaseId, lockedAt);
  const caller: LeaseClaimant =
    request.claimant === 'person'
      ? { claimant: 'person', actorId: request.holderActorId }
      : { claimant: 'agent', actorId: request.holderActorId, delegationId: request.delegationId };
  if (lease === undefined || !holdsLease(lease, caller)) {
    return refuseLease('not_owned', LEASE_FIXES.heartbeat.notOwned);
  }
  const fenced = fenceCause(lease, request.fence);
  if (fenced === 'fence_presented' || fenced === 'fence_superseded') {
    return refuseLease(fenced, LEASE_FIXES.heartbeat.notOwned);
  }
  // A person's lease carries no delegation, so its liveness is the person's
  // own current authority instead, and losing it is the same answer.
  const authorityLive =
    request.claimant === 'person'
      ? await personWriteLive(tx, request, lease.task_id, lockedAt)
      : lease.delegation_live;
  if (!authorityLive && request.claimant === 'person' && fenced === null) {
    return refuseLease('authority_lost', LEASE_FIXES.heartbeat.lost);
  }
  if (fenced !== null) return refuseLease(fenced, LEASE_FIXES.heartbeat.expired);
  if (!authorityLive) return refuseLease('not_live', LEASE_FIXES.heartbeat.expired);
  return { ok: true, value: lease.task_id };
}

/**
 * Write: the lease reaches at most one renewal past the locked instant and no
 * further than its lifetime after the pickup, and never shortens. An agent's
 * delegation moves with it, copied from the lease row in SQL rather than
 * through the `Date`, which keeps milliseconds where the column keeps
 * microseconds.
 */
async function renew(
  tx: TenantQuery,
  request: HeartbeatRequest | PersonHeartbeatRequest,
  delegationId: string | null,
  lockedAt: string,
): Promise<Date> {
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
  if (delegationId !== null) {
    await tx.query(
      `update public.delegations d set expires_at = l.expires_at
         from public.leases l
        where d.business_id = $1 and d.id = $2 and d.revoked_at is null and d.settled_at is null
          and l.business_id = $1 and l.id = $3`,
      [tx.businessId, delegationId, request.leaseId],
    );
  }
  return expiresAt;
}
