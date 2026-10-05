// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #756, #939: the lease-expiry sweep's release of model calls never
// started (`sweepModelCalls`, broker.ts). A call its hold counted gives that
// back under its envelope and hold; one it never counted is released on its
// row's lock alone, which a count that read it unsent takes before it commits.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { COUNTED_CAUSES, countedHold, giveBack } from './broker-give-back.ts';

/**
 * The sweep's release of calls never started on a lease that ended. One its
 * hold counted (a top-up, or the end at a stop) gives that back (`giveBack`).
 */
export async function releaseUnsent(tx: TenantQuery): Promise<readonly { readonly id: string }[]> {
  // A counted call's envelope and hold, before its row, as settlement takes
  // them. This runs after the lost-worker sweep's locks in one transaction, so
  // it never waits out of the contract's order: a counted call whose envelope
  // or hold another transaction holds is skipped, and the next pass takes it.
  const counted = await tx.query<{ readonly id: string }>(
    `select c.id from public.model_calls c
       join public.leases l on l.business_id = c.business_id and l.id = c.lease_id
       join public.reservations r on r.business_id = c.business_id and r.id = c.reservation_id
       join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
      where c.business_id = $1 and c.state = 'reserved'
        and (l.state <> 'live' or l.expires_at <= clock_timestamp())
        and ${countedHold('$2')}
        for update of e, r skip locked`,
    [tx.businessId, COUNTED_CAUSES],
  );
  // A call its hold never counted has nothing to give back and is released
  // without the hold's lock, so a start that holds it, its lease run out since
  // its checks, finds the call released and sends nothing (catalogue #421).
  // Its row is locked first, skipping one a count holds, and "never counted"
  // is read after: a count that read it unsent locks it before it commits and
  // gives back one released meanwhile (`giveBackReleased`, catalogue #939).
  const unsent = await tx.query<{ readonly id: string }>(
    `select c.id from public.model_calls c
       join public.leases l on l.business_id = c.business_id and l.id = c.lease_id
      where c.business_id = $1 and c.state = 'reserved'
        and (l.state <> 'live' or l.expires_at <= clock_timestamp())
        and not (c.id = any($2::uuid[]))
        for update of c skip locked`,
    [tx.businessId, counted.map((row) => row.id)],
  );
  // The release reads the lease again: a renewal committed since keeps its call reserved.
  const released = await tx.query<{ readonly id: string; readonly counted: boolean }>(
    `update public.model_calls c
        set state = 'released', ended_at = clock_timestamp()
       from public.reservations r, public.leases l
      where c.business_id = $1 and r.business_id = c.business_id and r.id = c.reservation_id
        and l.business_id = c.business_id and l.id = c.lease_id
        and c.state = 'reserved' and (l.state <> 'live' or l.expires_at <= clock_timestamp())
        and (c.id = any($2::uuid[]) or (c.id = any($4::uuid[]) and not ${countedHold('$3')}))
      returning c.id, c.id = any($2::uuid[]) as counted`,
    [tx.businessId, counted.map((row) => row.id), COUNTED_CAUSES, unsent.map((row) => row.id)],
  );
  for (const { id, counted: due } of released) {
    // One call at a time, on the sweep's one connection.
    // eslint-disable-next-line no-await-in-loop
    if (due) await giveBack(tx, id);
  }
  return released;
}
