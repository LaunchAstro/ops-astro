// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 FIXMONEY, SL11-30 GIVEBACK: a call counted at its maximum gives back
// what it did not spend when it ends lower, once.
//
// Two steps count a hold's open calls at their maximum (`spentOn`,
// `core-runtime/src/budget-stop.ts`): a budget top-up moving the spend to date
// to the envelope's actual (`raiseHold`), and the end at a budget stop
// (`budget_stop_ended`). The classifier never does: a hold with a call open is
// kept whole for a person, and one with none settles at its settled calls
// (AW-01, `recovery/classifier.ts`). A call that was open at a top-up or the
// end and ends now, settled lower, released, or resolved by a person or a
// provider's proof, gives the difference back to its own hold's envelope:
// - to the envelope's actual once the hold is history;
// - while a topped-up hold is still held, back onto the hold it came from, so
//   a replacement's size sees it, and nothing is given back twice.
// A hold that ended any other way (the classifier's settle, a person's outcome
// or write-off with no top-up, an observed cost) never counted its calls, and
// gives nothing back.
//
// Each caller reaches here only for a call it just moved out of an open or
// unknown state, under the envelope's lock it took first, so the difference is
// given once; the hold is locked here too, after the envelope, so its state
// stands.

import type { TenantQuery } from '../../core-records/src/index.ts';

/** The abandonment that counted the hold's open calls: the end at a budget stop. */
export const COUNTED_CAUSES: readonly string[] = ['budget_stop_ended'];

/**
 * The hold `r` counted its open calls at their maximum: ended at a budget stop
 * (`causes` names the parameter holding COUNTED_CAUSES), or topped up.
 */
export const countedHold = (causes: string): string =>
  `((r.state = 'abandoned' and r.classified_cause = any(${causes}::text[]))
     or (r.state in ('held', 'actual', 'abandoned') and exists (
           select 1 from public.budget_answers ba
             join public.budget_asks k on k.business_id = ba.business_id and k.id = ba.ask_id
            where ba.business_id = r.business_id and k.reservation_id = r.id
              and ba.kind = 'top_up')))`;

interface Due {
  readonly reservation_id: string;
  readonly envelope_id: string;
  readonly held: boolean;
  readonly back: string;
}

/**
 * The call's envelope, first in the contract's order (cap, envelope, task, ...):
 * settlement takes it by the call's rows (`lockCall`), and a start or a proved
 * release before its call can close and give back (`giveBack`).
 */
export async function lockEnvelope(tx: TenantQuery, callId: string): Promise<void> {
  await tx.query(
    `select 1 from public.model_calls c
       join public.reservations r on r.business_id = c.business_id and r.id = c.reservation_id
       join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
      where c.business_id = $1 and c.id = $2 for update of e`,
    [tx.businessId, callId],
  );
}

/** Give back what the ended call did not spend, when its hold counted it at its maximum. */
export async function giveBack(tx: TenantQuery, callId: string): Promise<void> {
  const [due] = await tx.query<Due>(
    `select r.id as reservation_id, r.envelope_id, r.state = 'held' as held,
            (c.reserved_minor - coalesce(c.actual_minor, 0))::text as back
       from public.model_calls c
       join public.reservations r on r.business_id = c.business_id and r.id = c.reservation_id
      where c.business_id = $1 and c.id = $2 and c.state in ('settled', 'released')
        and ${countedHold('$3')}
        for update of r`,
    [tx.businessId, callId, COUNTED_CAUSES],
  );
  if (due === undefined || Number(due.back) <= 0) return;
  if (due.held) {
    await tx.query(
      `update public.reservations set held_minor = held_minor + $3
        where business_id = $1 and id = $2 and state = 'held'`,
      [tx.businessId, due.reservation_id, due.back],
    );
  }
  await tx.query(
    `update public.task_envelopes
        set actual_minor = actual_minor - $3, held_minor = held_minor + $4
      where business_id = $1 and id = $2`,
    [tx.businessId, due.envelope_id, due.back, due.held ? due.back : 0],
  );
}
