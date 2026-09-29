// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's `receipt written`: the observed publish or revert result and its
// receipt, in one transaction under a live worker lease on the correction's
// task (TR-S-R4-10). If the receipt cannot be written, the state does not move.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { CorrectionState } from './live-corrections.ts';

export interface ObservedResult {
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly step: 'publish' | 'revert';
  readonly outcome: 'accepted' | 'live' | 'unknown' | 'failed' | 'reverted';
  readonly observations: Readonly<Record<string, unknown>>;
}

/** The states each step may move from. A publish needs the approval; a revert a live page. */
const FROM: Readonly<Record<ObservedResult['step'], readonly CorrectionState[]>> = {
  publish: ['approved', 'accepted', 'unknown'],
  revert: ['live'],
};

export type ObservedRefusal = 'LEASE_NOT_OWNED' | 'NOT_FOUND' | 'GATE_NOT_APPROVED';

/**
 * `receipt written`: the observed result and its receipt, together.
 *
 * Under a live worker lease on the correction's task with the fence the worker
 * holds, both locked; the correction row locked next. The state moves and the
 * receipt is appended in this transaction, so a receipt that fails to write
 * leaves no moved state behind it, and a state never moves without its receipt.
 */
export async function recordObservedResult(
  tx: TenantQuery,
  result: ObservedResult,
): Promise<
  | { readonly ok: true; readonly receiptId: string }
  | { readonly ok: false; readonly code: ObservedRefusal }
> {
  const correction = await tx.query<{ readonly task_id: string; readonly state: CorrectionState }>(
    `select task_id, state from public.live_corrections
      where business_id = $1 and id = $2 for update`,
    [tx.businessId, result.correctionId],
  );
  const row = correction[0];
  if (row === undefined) return { ok: false, code: 'NOT_FOUND' };
  const lease = await tx.query<{ readonly id: string }>(
    `select id from public.leases
      where business_id = $1 and id = $2 and task_id = $3 and fence = $4
        and state = 'live' and expires_at > now()
      for share`,
    [tx.businessId, result.leaseId, row.task_id, result.fence],
  );
  if (lease.length === 0) return { ok: false, code: 'LEASE_NOT_OWNED' };
  if (!FROM[result.step].includes(row.state)) return { ok: false, code: 'GATE_NOT_APPROVED' };

  await tx.query(
    `update public.live_corrections
        set state = $3, revision = revision + 1, updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, result.correctionId, result.outcome],
  );
  const receiptId = randomUUID();
  await tx.query(
    `insert into public.live_correction_receipts
       (business_id, id, correction_id, lease_id, fence, step, outcome, observations)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)`,
    [
      tx.businessId,
      receiptId,
      result.correctionId,
      result.leaseId,
      result.fence,
      result.step,
      result.outcome,
      JSON.stringify(result.observations),
    ],
  );
  return { ok: true, receiptId };
}
