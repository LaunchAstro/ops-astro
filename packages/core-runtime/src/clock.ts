// SPDX-License-Identifier: AGPL-3.0-only
//
// The database clock, read once the locks are held.
//
// `now()` is the transaction's start. A command that began before a deadline
// and then waited on a lock until after it would still see `now()` before the
// deadline, and approve a gate or renew a lease that had already expired while
// it waited. `clock_timestamp()` is the actual instant, so a
// caller reads it once, after `acquire` returns, and uses that one instant for
// every expiry check and renewal in the rest of the transaction.
//
// A business setting a caller reads under its locks can make it wait too: on
// the settings install lock, while a first install runs, and on the setting's
// row, while a change is in flight. So the caller names those settings here
// and they are held before the instant is read, never after it.

import { lockSettingsInstall, type TenantQuery } from '../../core-records/src/index.ts';

/** A business setting a command reads under its locks. */
export type HeldSetting = 'client_sign_off_required' | 'four_eyes_threshold';

/**
 * The database's current instant as text, to be passed back as
 * `$n::text::timestamptz`. Text rather than a `Date`, which keeps milliseconds
 * where the column keeps microseconds; bound as `$n::timestamptz` the driver
 * makes it a `Date` all the same. `settings` are held first, to commit: the
 * install lock shared, then their rows `for share`.
 */
export async function lockedInstant(
  tx: TenantQuery,
  settings: readonly HeldSetting[] = [],
): Promise<string> {
  if (settings.length > 0) {
    await lockSettingsInstall(tx, 'shared');
    await tx.query(
      `select 1 from public.business_settings
        where business_id = $1 and key = any($2::text[])
        for share`,
      [tx.businessId, settings],
    );
  }
  const found = await tx.query<{ readonly at: string }>(`select clock_timestamp()::text as at`);
  const at = found[0]?.at;
  if (at === undefined) throw new Error('lockedInstant: the database returned no clock');
  return at;
}
