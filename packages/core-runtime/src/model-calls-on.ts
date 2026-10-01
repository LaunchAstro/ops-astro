// SPDX-License-Identifier: AGPL-3.0-only
//
// A hold's model calls, as the recovery paths and the hand-back read them. Kept out of
// recovery/classifier.ts so the classifier stays under CQ-8's 600 lines.

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * What a hold's model calls settled at, and whether one was sent and never settled.
 * After a top-up there is nothing more: it moved the spend to date (AW-05, `budget-answer.ts`).
 */
export async function modelCallsOn(
  tx: TenantQuery,
  reservationId: string,
): Promise<{ readonly spentMinor: bigint; readonly open: boolean }> {
  const [calls] = await tx.query<{ readonly spent: string; readonly open: boolean }>(
    `select coalesce(sum(c.actual_minor) filter (where c.state = 'settled'), 0)::text as spent,
            coalesce(bool_or(c.state in ('dispatched', 'liability_unknown')), false) as open
       from public.model_calls c
      where c.business_id = $1 and c.reservation_id = $2
        and not exists (select 1 from public.budget_asks k
                          join public.budget_answers a
                            on a.business_id = k.business_id and a.ask_id = k.id
                         where k.business_id = c.business_id and k.reservation_id = c.reservation_id
                           and a.kind = 'top_up')`,
    [tx.businessId, reservationId],
  );
  return { spentMinor: BigInt(calls?.spent ?? '0'), open: calls?.open ?? false };
}
