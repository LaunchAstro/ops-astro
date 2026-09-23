// SPDX-License-Identifier: AGPL-3.0-only
//
// The database clock, read once the locks are held.
//
// `now()` is the transaction's start. A command that began before a deadline
// and then waited on a lock until after it would still see `now()` before the
// deadline, and approve a gate or renew a lease that had already expired while
// it waited (Sol 6 RUNTIME-3). `clock_timestamp()` is the actual instant, so a
// caller reads it once, after `acquire` returns, and uses that one instant for
// every expiry check and renewal in the rest of the transaction.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';

/**
 * The database's current instant as text, to be passed back as
 * `$n::timestamptz`. Text rather than a `Date`, which keeps milliseconds where
 * the column keeps microseconds.
 */
export async function lockedInstant(tx: TenantQuery): Promise<string> {
  const found = await tx.query<{ readonly at: string }>(`select clock_timestamp()::text as at`);
  const at = found[0]?.at;
  if (at === undefined) throw new Error('lockedInstant: the database returned no clock');
  return at;
}
