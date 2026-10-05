// SPDX-License-Identifier: AGPL-3.0-only
//
// One export per business at a time (#963): a lease on the business's export
// cursor row. An export takes it in the transaction that reads its batch,
// renews it before each body, and gives it up in the transaction that
// advances the cursor or records the gap. Another export takes it only once
// it has expired. So two exports never send at once: a failing one can delay
// a healthy one's tick, never undo it. A gap whose body the target may still
// store (`MAYBE_STORED`) keeps the lease to its end rather than giving it up,
// so a late store lands before the next export sends; one later than the
// lease is not held off. The lease is time only, with no token the target
// checks: a holder stalled for most of the lease between its renewal and
// custody's send could still send after a takeover.
//
// Every statement takes the row lock and reads the time after the lock wait
// (`clock_timestamp()`, never the transaction's start). A renewal holds only
// on the row's version the holder last wrote: a takeover, or retention's
// step back (`sendAgain` in `trace-retention.ts`), gives the row a new one,
// and the holder sends nothing more.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { GapCode } from './trace-delivery.ts';

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
 * How long a lease runs past its last renewal, in seconds. Custody bounds a
 * body's delivery from its own start (5 s), well inside the lease.
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

/**
 * The gaps whose body the target may have stored all the same. The rest are
 * answers that say it took nothing; a target that stores a body and then
 * answers 5xx anyway is not held off.
 */
const MAYBE_STORED: ReadonlySet<GapCode> = new Set<GapCode>([
  'target_timeout',
  'target_unreachable',
  'target_malformed_reply',
  'target_oversized_reply',
]);

/**
 * Ends `holder`'s export: gives the lease up, or after a gap whose body may
 * have been stored, keeps it to its end. The hold asks only that `holder`
 * still has the lease, whatever the version: a retention step meanwhile
 * gave the row a new one, and the stepped-back resend must still wait.
 */
export async function letGo(
  tx: TenantQuery,
  holder: string,
  code: GapCode | null,
): Promise<void> {
  if (code === null || !MAYBE_STORED.has(code)) {
    await release(tx, holder);
    return;
  }
  await tx.query(
    `update public.trace_export_cursors
        set lease_until = clock_timestamp() + make_interval(secs => $3)
      where business_id = $1 and lease_holder = $2`,
    [tx.businessId, holder, TRACE_LEASE_SECONDS],
  );
}

/** Gives up `holder`'s lease, if it still holds it. */
export async function release(tx: TenantQuery, holder: string): Promise<void> {
  await tx.query(
    `update public.trace_export_cursors set lease_holder = null, lease_until = null
      where business_id = $1 and lease_holder = $2`,
    [tx.businessId, holder],
  );
}
