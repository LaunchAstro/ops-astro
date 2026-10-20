// SPDX-License-Identifier: AGPL-3.0-only
//
// The outbound prompt's copy (AW-01): registered before it is first
// materialised, and checked before anything is sent. Moved whole from
// `broker-reserve.ts` to keep it under its line cap; it re-exports both.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';

/** Register the outbound prompt's copy before it is first materialised. */
export async function registerPromptCopy(tx: TenantQuery, callId: string): Promise<void> {
  await tx.query(
    `insert into public.copy_registrations
       (business_id, id, copy_class, copy_key, invalidation_trigger, retention_class)
     values ($1, $2, 'outbound_prompt', $3, 'call_ended', 'transient')`,
    [tx.businessId, randomUUID(), `model_call:${callId}`],
  );
}

/** Refuses unless the copy is registered: nothing is copied or sent before this answers true. */
export async function promptCopyRegistered(tx: TenantQuery, callId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.copy_registrations
      where business_id = $1 and copy_class = 'outbound_prompt' and copy_key = $2`,
    [tx.businessId, `model_call:${callId}`],
  );
  return rows.length === 1;
}
