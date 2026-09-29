// SPDX-License-Identifier: AGPL-3.0-only
//
// Authority loss: what a revocation classifies, under the locks the revoking
// transaction holds. The rules it keeps are in `../recovery.ts`, the module's
// one surface.

import { revokeDelegation } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { LockSet } from '../locks.ts';
import { lockRediscovered } from '../rediscovery.ts';
import {
  AFFECTED_COLUMNS,
  AFFECTED_JOINS,
  classifyAll,
  locksFor,
  type Affected,
  type Classification,
} from './classifier.ts';
import {
  discoverLiveWork,
  liveWorkLocks,
  reopenRuns,
  retireWork,
  type LiveWork,
} from './lease-retirement.ts';

/** What a revocation wrote under the locks, and whose work authority it cost. */
export type RevocationWrite<T> =
  | { readonly applied: false; readonly value: T }
  | {
      readonly applied: true;
      readonly value: T;
      /** The delegations that lost their work authority. */
      readonly lost: readonly string[];
      /** EX-01: the person's own leases, which carry no delegation, that lost it. */
      readonly lostLeases: readonly string[];
    };

/** The two columns a lost unit is matched on, which live work and held rows share. */
type Leased = Pick<Affected, 'lease_id' | 'delegation_id'>;

/** One delegation or person lease whose work authority a revocation cost. */
interface LostUnit {
  readonly match: (row: Leased) => boolean;
  readonly causeId: string;
  /** The delegation to revoke, when the unit is one. A person's lease has none. */
  readonly revoke?: string;
}

export interface AuthorityLoss<T> {
  readonly value: T;
  readonly applied: boolean;
  readonly classified: readonly Classification[];
}

/**
 * Recorded authority loss, as an owning transition: `delegation.revoke`
 * and `grant.revoke` both end here.
 *
 * `delegationIds` is every delegation the revocation might cost its work
 * authority, discovered by the caller before any lock. This discovers the live
 * leases issued under them and the holds bound to those leases, takes the
 * complete set (cap, envelope, task, run, lineage, lease, delegation,
 * reservation) in `LOCK_ORDER`, and re-reads it. Only then does `revoke` run:
 * it writes the revocation itself and names, from what it re-read under the
 * locks, the delegations that actually lost authority. Each of those is
 * revoked, its live lease released and fenced, and its holds classified as
 * `authority_revoked` with the delegation as the recorded cause.
 *
 * A marked or observed attempt is quarantined by the classifier with its full
 * hold, exactly as it is under every other cause.
 *
 * EX-01. A person's own lease carries no delegation, so `personLeases` names
 * those leases directly, with the revoked grant as their recorded cause. They
 * join the same lock set, and `revoke` names the ones that lost authority in
 * `lostLeases`. Each run whose claim ended goes back to `planned`.
 */
export async function classifyAuthorityLoss<T>(
  tx: TenantQuery,
  request: {
    readonly delegationIds: readonly string[];
    readonly personLeases?: { readonly leaseIds: readonly string[]; readonly causeId: string };
    readonly revoke: (locks: LockSet) => Promise<RevocationWrite<T>>;
  },
): Promise<AuthorityLoss<T>> {
  const ids = [...new Set(request.delegationIds)].toSorted();
  const leaseIds = [...new Set(request.personLeases?.leaseIds ?? [])].toSorted();
  const discoverWork = async (): Promise<readonly LiveWork[]> =>
    await discoverLiveWork(tx, { delegationIds: ids, personLeaseIds: leaseIds });
  const discoverHeld = async (): Promise<readonly Affected[]> =>
    await tx.query<Affected>(
      `select ${AFFECTED_COLUMNS}, 'authority_revoked' as cause,
              coalesce(held_lease.delegation_id, $4::uuid) as cause_id
         ${AFFECTED_JOINS}
        where res.business_id = $1 and res.state = 'held' and held_lease.state = 'live'
          and (held_lease.delegation_id = any($2::uuid[])
               or (held_lease.delegation_id is null and held_lease.id = any($3::uuid[])))
        order by res.id`,
      [tx.businessId, ids, leaseIds, request.personLeases?.causeId ?? null],
    );

  const {
    locks,
    found: [workAfter, heldAfter],
  } = await lockRediscovered(tx, {
    discover: async () => [await discoverWork(), await discoverHeld()] as const,
    locks: ([work, held]) => [
      ...locksFor(held),
      ...liveWorkLocks(work),
      // A delegation with no live lease is still the row being revoked.
      ...ids.map((id) => ({ lockClass: 'delegation' as const, id })),
    ],
    rule: 'exact',
    changed:
      'authority loss: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
  });

  const written = await request.revoke(locks);
  if (!written.applied) return { value: written.value, applied: false, classified: [] };

  // Each unit that lost its authority, delegations first and then a person's
  // own leases. `match` picks out the unit's live work and its holds, and
  // `causeId` is the recorded cause those holds are classified under.
  const lost = new Set(written.lost);
  const lostLeases = new Set(written.lostLeases);
  const person = request.personLeases;
  const units: readonly LostUnit[] = [
    ...ids
      .filter((each) => lost.has(each))
      .map((id) => ({ match: (row: Leased) => row.delegation_id === id, causeId: id, revoke: id })),
    ...(person === undefined
      ? []
      : leaseIds
          .filter((each) => lostLeases.has(each))
          .map((leaseId) => ({
            match: (row: Leased) => row.lease_id === leaseId && row.delegation_id === null,
            causeId: person.causeId,
          }))),
  ];

  const classified: Classification[] = [];
  const ended: string[] = [];
  const end = async (unit: LostUnit): Promise<void> => {
    if (unit.revoke !== undefined) {
      locks.require('delegation', unit.revoke);
      // Revoked here as well as by `delegation.revoke`'s own write, because a
      // grant revocation costs the delegation its authority without touching
      // its row, and the classifier's fact is that row's `revoked_at`. The
      // cause is recorded in the same write and the same transaction (root
      // ruling R-B): `authority_lost`, which the agent's next call on that
      // credential answers as `DELEGATION_NARROWED`. After an explicit
      // `delegation.revoke` the row is already revoked with its own cause and
      // this writes nothing.
      await revokeDelegation(tx, unit.revoke, 'authority_lost');
    }
    const work = workAfter.filter((row) => unit.match(row));
    await retireWork(tx, work, locks);
    ended.push(...work.map((row) => row.run_id));
    const holds = heldAfter.filter((row) => unit.match(row));
    classified.push(
      ...(await classifyAll(tx, holds, locks, (row) => ({
        reservationId: row.reservation_id,
        cause: 'authority_revoked',
        causeId: unit.causeId,
      }))),
    );
  };
  for (const unit of units) {
    // eslint-disable-next-line no-await-in-loop
    await end(unit);
  }
  await reopenRuns(tx, ended, locks);
  return { value: written.value, applied: true, classified };
}
