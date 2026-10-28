// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a step was written off: the one fact a pickup (`pickup.ts`), a top-up at a
// budget stop (`recorded-refusal.ts`) and a resume (`recovery/reconcile.ts`) read. A step
// any of whose attempts a person wrote off, at nothing or above, never runs again (#2277).

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * SQL, true when an attempt of the step `step` names, in the business `business` names, was
 * written off. Both are column references in the caller's own query, never input.
 *
 * A write-off leaves outcome `unknown` on the attempt (quarantine's is not one) or, where a
 * marked attempt written off at nothing cannot carry it, cause `written_off` on its hold
 * (`write-off.ts`). One at nothing before #2282 left neither once its calls had spent: the
 * attempt `abandoned` under `abandoned` and the hold `actual` with no cause, as a person's
 * `nothing_happened` leaves them, and an outcome never changes (0014). Its applied operation,
 * written in the write-off's own transaction and never changed (0007), still marks it (#2283).
 */
export const stepWrittenOff = (business: string, step: string): string => `exists (
  select 1 from public.attempts w
    join public.reservations wr on wr.business_id = w.business_id and wr.id = w.reservation_id
   where w.business_id = ${business} and w.step_id = ${step}
     and ((w.outcome = 'unknown' and w.state <> 'quarantined')
          or wr.classified_cause = 'written_off'
          or exists (select 1 from public.operations o
                      where o.business_id = w.business_id and o.command = 'budget.write_off'
                        and o.outcome = 'applied' and o.result -> 'detail' ->> 'state' = 'applied'
                        and o.result -> 'detail' ->> 'attemptId' = w.id::text)))`;

/**
 * Whether a person wrote off any attempt of this attempt's step, read in the caller's
 * transaction; the caller holds the step's lock, which a write-off takes too.
 */
export async function stepIsWrittenOff(tx: TenantQuery, attemptId: string): Promise<boolean> {
  const [found] = await tx.query<{ readonly written_off: boolean }>(
    `select ${stepWrittenOff('att.business_id', 'att.step_id')} as written_off
       from public.attempts att
      where att.business_id = $1 and att.id = $2`,
    [tx.businessId, attemptId],
  );
  return found?.written_off === true;
}
