// SPDX-License-Identifier: AGPL-3.0-only
//
// A reconciliation lookup's slot on the call it asks about (`lookup_until`,
// migration 20261004040000), and its place in the line (`broker-reconcile.ts`).

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * The lookup's slot on its call, in the gate's transaction: null when the
 * call is no longer held unknown or another pass's slot on it is unexpired.
 * The answer is the slot's end, which only this taking wrote, so the give
 * back clears this slot and never a later one.
 */
export async function takeSlot(
  tx: TenantQuery,
  callId: string,
  boundMs: number,
): Promise<string | null> {
  const [taken] = await tx.query<{ until: string }>(
    `update public.model_calls set lookup_until = clock_timestamp() + $3 * interval '1 millisecond'
      where business_id = $1 and id = $2 and state = 'liability_unknown' and outcome is null
        and (lookup_until is null or lookup_until <= clock_timestamp())
      returning lookup_until::text as until`,
    [tx.businessId, callId, boundMs],
  );
  return taken?.until ?? null;
}

/**
 * A call whose route has no room goes to the back of the line, as an answered
 * one does, so fifty waiting on a full route never keep a call on a free one
 * from being asked. Its time only: an unexpired slot stays as it is.
 */
export async function waitsItsTurn(tx: TenantQuery, callId: string): Promise<null> {
  await tx.query(
    `update public.model_calls set lookup_until = greatest(lookup_until, clock_timestamp())
      where business_id = $1 and id = $2 and state = 'liability_unknown' and outcome is null`,
    [tx.businessId, callId],
  );
  return null;
}

/** Sent as text: a parameter typed `timestamptz` would pass through a JS Date and lose microseconds. */
export async function giveSlot(tx: TenantQuery, callId: string, slot: string): Promise<void> {
  await tx.query(
    `update public.model_calls set lookup_until = null
      where business_id = $1 and id = $2 and lookup_until = $3::text::timestamptz`,
    [tx.businessId, callId, slot],
  );
}
