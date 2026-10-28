// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a step was written off: the one fact the queue and a pickup (`pickup.ts`), a top-up
// at a budget stop (`recorded-refusal.ts`), a resume (`recovery/reconcile.ts`) and the pass's
// stop of a replacement (`recovery/written-off-replacements.ts`) read. A step any of whose
// attempts a person wrote off, at nothing or above, never runs again (#2277).

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * SQL, the attempts of the step `step` names, in the business `business` names, that a person
 * wrote off. Both are column references in the caller's own query, never input.
 *
 * A write-off leaves outcome `unknown` on the attempt (quarantine's is not one) or, where a
 * marked attempt written off at nothing cannot carry it, cause `written_off` on its hold
 * (`write-off.ts`). One at nothing before #2282 left neither once its calls had spent: the
 * attempt `abandoned` under `abandoned` and the hold `actual` with no cause, as a person's
 * `nothing_happened` leaves them, and an outcome never changes (0014). Its applied operation,
 * written in the write-off's own transaction and never changed (0007), still marks it (#2283).
 */
const writtenOff = (business: string, step: string): string => `select w.id from public.attempts w
    join public.reservations wr on wr.business_id = w.business_id and wr.id = w.reservation_id
   where w.business_id = ${business} and w.step_id = ${step}
     and ((w.outcome = 'unknown' and w.state <> 'quarantined')
          or wr.classified_cause = 'written_off'
          or exists (select 1 from public.operations o
                      where o.business_id = w.business_id and o.command = 'budget.write_off'
                        and o.outcome = 'applied' and o.result -> 'detail' ->> 'state' = 'applied'
                        and o.result -> 'detail' ->> 'attemptId' = w.id::text))`;

/** SQL, true when an attempt of that step was written off (`writtenOff`). */
export const stepWrittenOff = (business: string, step: string): string =>
  `exists (${writtenOff(business, step)})`;

/**
 * The attempt of this attempt's step a person wrote off, if any, read in the caller's
 * transaction; the caller holds the step's lock, which a write-off takes too.
 */
export async function writtenOffAttemptOf(
  tx: TenantQuery,
  attemptId: string,
): Promise<string | undefined> {
  const [found] = await tx.query<{ readonly id: string | null }>(
    `select (${writtenOff('att.business_id', 'att.step_id')} order by w.id limit 1) as id
       from public.attempts att
      where att.business_id = $1 and att.id = $2`,
    [tx.businessId, attemptId],
  );
  return found?.id ?? undefined;
}

/** Whether a person wrote off any attempt of this attempt's step, as `writtenOffAttemptOf`. */
export const stepIsWrittenOff = async (tx: TenantQuery, attemptId: string): Promise<boolean> =>
  (await writtenOffAttemptOf(tx, attemptId)) !== undefined;
