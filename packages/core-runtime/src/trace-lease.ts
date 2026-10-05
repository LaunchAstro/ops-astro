// SPDX-License-Identifier: AGPL-3.0-only
//
// One export per business at a time (#963): a lease on the business's export
// cursor row. An export takes it in the transaction that reads its batch,
// renews it before each body, and gives it up in the transaction that
// advances the cursor or records the gap. Another export takes it only once
// it has expired. So two exports never deliver at once: a failing one can
// delay a healthy one's tick, never undo it, and a slower one never stores a
// body after a faster one has moved on.
//
// Every statement takes the row lock and reads the time after the lock wait
// (`clock_timestamp()`, never the transaction's start). A renewal holds only
// on the row's version the holder last wrote: a takeover, or retention's
// step back (`sendAgain` in `trace-retention.ts`), gives the row a new one,
// and the holder sends nothing more.

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * The cursor as one read saw it: its place `(tx, id)`, both null before the
 * first advance, and its row's version (`xmin`). Every write to the row gives
 * it a new version.
 */
export interface Cursor {
  readonly tx: string | null;
  readonly id: string | null;
  readonly version: string | null;
}

/**
 * How long a lease runs past its last renewal, in seconds. A body's delivery
 * is bounded by custody's deadline (5 s), so a body in flight never outlives
 * the lease it was sent under.
 */
const TRACE_LEASE_SECONDS = 60;

/**
 * Takes the lease for `holder` when no export holds it or its lease has
 * expired, creating the cursor row before the first export. Answers the
 * cursor as the lease found it, its version the one `holder` just wrote, or
 * null when another export holds it.
 */
export async function take(tx: TenantQuery, holder: string): Promise<Cursor | null> {
  const [row] = await tx.query<Cursor>(
    `insert into public.trace_export_cursors as c (business_id, lease_holder, lease_until)
     values ($1, $2, clock_timestamp() + make_interval(secs => $3))
     on conflict (business_id) do update
       set lease_holder = excluded.lease_holder,
           lease_until = clock_timestamp() + make_interval(secs => $3)
       where c.lease_holder is null or c.lease_until <= clock_timestamp()
     returning c.after_tx::text as tx, c.after_id as id, c.xmin::text as version`,
    [tx.businessId, holder, TRACE_LEASE_SECONDS],
  );
  return row ?? null;
}

/**
 * Renews `holder`'s lease on the version it last wrote. Answers the new
 * version, or null, having let the lease go, when the row has moved on.
 */
export async function renew(
  tx: TenantQuery,
  holder: string,
  version: string | null,
): Promise<string | null> {
  const [row] = await tx.query<{ readonly version: string }>(
    `update public.trace_export_cursors
        set lease_until = clock_timestamp() + make_interval(secs => $4)
      where business_id = $1 and lease_holder = $2 and xmin = $3::xid
      returning xmin::text as version`,
    [tx.businessId, holder, version, TRACE_LEASE_SECONDS],
  );
  if (row === undefined) await release(tx, holder);
  return row?.version ?? null;
}

/** Gives up `holder`'s lease, if it still holds it. */
export async function release(tx: TenantQuery, holder: string): Promise<void> {
  await tx.query(
    `update public.trace_export_cursors set lease_holder = null, lease_until = null
      where business_id = $1 and lease_holder = $2`,
    [tx.businessId, holder],
  );
}
