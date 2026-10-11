// SPDX-License-Identifier: AGPL-3.0-only
//
// P20 (U115): a live record's data rewritten in one statement that also names
// the top-level keys the write actually changed.
//
// The database compares the stored data before and after the update
// (`record_changed_field_keys`, migration 20261011034325), so the answer is
// what was written, not what was asked for: a key sent with its current value
// is not a change, and a clear the write causes is one. The "before" is read
// in the same statement as the update, so it is the row the update replaces;
// a command's target row is already locked by its envelope (`prepare.ts`).
// Only the names leave this function, never a value.

import type { TenantQuery } from '../tenancy/database.ts';

export interface DataWrite {
  readonly revision: number;
  /** The keys whose stored value differs after the write: sorted, each once, empty for none. */
  readonly changed: readonly string[];
}

/**
 * Rewrite one live record's data. `set` is the update's assignment list, SQL
 * text the caller writes and never a value: it reads `data` as the row's
 * current data and takes its values from `$3` on, in the order of `values`.
 * Undefined when no live record carries the id.
 */
export async function writeRecordData(
  tx: TenantQuery,
  recordId: string,
  set: string,
  values: readonly unknown[],
): Promise<DataWrite | undefined> {
  const rows = await tx.query<{ readonly revision: string; readonly changed: readonly string[] }>(
    `with before as (
       select data as before_data from records
        where business_id = $1 and id = $2 and deleted_at is null
     )
     update records set ${set}
       from before
      where business_id = $1 and id = $2 and deleted_at is null
     returning revision::text as revision,
       public.record_changed_field_keys(before.before_data, records.data) as changed`,
    [tx.businessId, recordId, ...values],
  );
  const written = rows[0];
  return written === undefined
    ? undefined
    : { revision: Number(written.revision), changed: written.changed };
}
