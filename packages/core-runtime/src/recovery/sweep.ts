// SPDX-License-Identifier: AGPL-3.0-only
//
// T3b: the sweeper, the lease-expiry phase of the one reconciliation pass.
// T3d1 extends this pass and builds no second one. The API runs it on an
// interval, per business, as system work (`apps/api/recovery-entry.ts`): the
// worker holds no database (spike RN-04), so there is nothing in it to sweep
// with.
//
// **The deadline is the lease's own, read on the database clock.** A lease
// still live past its `expires_at` is fenced here, as `expired`, and that
// recorded fence is the cause the classifier then reads.
// Elapsed time never releases a hold by itself: it only ends a lease that ran
// out, and the classifier decides what the hold is from the rows.
//
// **Unmarked, the hold is released in full; marked, it is held unknown.** A
// step that never received its dispatch mark did nothing, so its hold goes
// back by amount. A marked step may have acted, and nobody has proved what it
// cost, so its attempt becomes `liability_unknown` at the whole reserved
// maximum, unconditionally, without asking the operation register (T3d1 asks).
// No timer path leaves that state: only a person's recorded outcome or
// write-off does (T3c, T3d1).
//
// **A lease that ran out with nothing reported is our worker lost** (T3e1,
// `drop.ts`): the drop is recorded with that cause, a person is told, and an
// unmarked step is reserved again, so the work comes back by itself.
//
// **It races dispatch on the lease and reservation locks.** Dispatch takes
// both; so does this. Whichever commits first wins: a sweep first fences the
// lease, and dispatch then refuses it; a dispatch first commits its mark, and
// the sweep then holds the step unknown. Never both a mark and a release.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { lockedInstant } from '../clock.ts';
import { lockRediscovered } from '../rediscovery.ts';
import {
  AFFECTED_COLUMNS,
  AFFECTED_JOINS,
  classifyAll,
  locksFor,
  type Affected,
  type Classification,
} from './classifier.ts';
import { recordDrop } from './drop.ts';
import { endLease } from './lease-retirement.ts';

/**
 * Holds bound to a live lease whose deadline has passed at `at`, in this
 * business only. An attempt already held unknown is not rediscovered: its
 * state is a person's to change, not the pass's.
 */
async function discoverExpired(tx: TenantQuery, at: string): Promise<readonly Affected[]> {
  return await tx.query<Affected>(
    `select ${AFFECTED_COLUMNS}, 'lease_expired_and_fenced' as cause, res.lease_id as cause_id
       ${AFFECTED_JOINS}
      where res.business_id = $1 and res.state = 'held'
        and held_lease.state = 'live' and held_lease.expires_at <= $2::timestamptz
        and not exists (select 1 from public.attempts att
                         where att.business_id = res.business_id and att.reservation_id = res.id
                           and att.state = 'liability_unknown')
      order by res.id`,
    [tx.businessId, at],
  );
}

/**
 * One sweep of one business, in the caller's transaction on the tenancy
 * connection. Discover, lock, rediscover, both at one instant read first: a
 * deadline already behind it stays behind it, so the set under the locks can
 * only shrink (a lease renewed or handed back in between drops out), which
 * the `covered` rule lets go on under the locks held. A lease that runs out
 * after that instant is the next pass's.
 */
export async function sweepExpiredLeases(tx: TenantQuery): Promise<readonly Classification[]> {
  const at = await lockedInstant(tx);
  const { locks, found } = await lockRediscovered(tx, {
    discover: async () => await discoverExpired(tx, at),
    locks: locksFor,
    rule: 'covered',
    changed:
      'sweep: the expired set changed under discovery; roll back and sweep again on the next pass',
  });
  const classified = await classifyAll(
    tx,
    found,
    locks,
    (row) => ({ reservationId: row.reservation_id, cause: row.cause, causeId: row.cause_id }),
    async (row) => {
      // The fence first, under the lease lock this set holds: the classifier
      // reads the lease's recorded end as the cause, never the clock.
      if (row.lease_id !== null) await endLease(tx, row.lease_id, 'expired');
    },
  );
  // T3e1: the lease ran out on its own clock and nobody reported why, so our
  // worker was lost. The drop is recorded, and unmarked work comes back.
  for (const row of found) {
    // Sequential: each reactivation reserves against the envelope the next may share.
    // eslint-disable-next-line no-await-in-loop
    const [attempt] = await tx.query<{ readonly id: string }>(
      'select id from public.attempts where business_id = $1 and reservation_id = $2',
      [tx.businessId, row.reservation_id],
    );
    if (attempt === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    await recordDrop(tx, { attemptId: attempt.id, cause: 'worker_lost', retire: true, locks });
  }
  return classified;
}
