// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 FIXMONEY, SL11-30 GIVEBACK: a call counted at its maximum gives back
// what it did not spend when it ends lower, once.
//
// Three steps count a hold's open calls at their maximum (`spentOn`,
// `core-runtime/src/recovery/classifier.ts`): the classifier settling a
// stopped hold (`actual`, or abandoned under its cause when a top-up already
// moved the spend), a budget top-up moving the spend to date to the
// envelope's actual (`raiseHold`), and the end at a budget stop
// (`budget_stop_ended`). A call that was open then and ends now, settled lower,
// released, or resolved by a person or a provider's proof, gives the
// difference back to its own hold's envelope:
// - to the envelope's actual once the hold is history;
// - while a topped-up hold is still held, back onto the hold it came from, so
//   the hold's later settle (`spendToSettle`) and a replacement's size
//   (`remainingOf`) both see it, and nothing is given back twice.
// A hold that ended any other way (a person's outcome or write-off with no
// top-up, an observed cost) never counted its calls, and gives nothing back.
//
// Each caller reaches here only for a call it just moved out of an open state,
// under the envelope's lock it took first, so the difference is given once;
// the hold is locked here too, after the envelope, so its state stands.

import type { TenantQuery } from '../../core-records/src/index.ts';

/** The abandonments that counted the hold's open calls: the classifier's causes and the end. */
const COUNTED_CAUSES = [
  'handback_completed',
  'lineage_rejected',
  'lineage_cancelled',
  'version_superseded',
  'authority_revoked',
  'lease_expired_and_fenced',
  'budget_stop_ended',
];

interface Due {
  readonly reservation_id: string;
  readonly envelope_id: string;
  readonly held: boolean;
  readonly back: string;
}

/** Give back what the ended call did not spend, when its hold counted it at its maximum. */
export async function giveBack(tx: TenantQuery, callId: string): Promise<void> {
  const [due] = await tx.query<Due>(
    `select r.id as reservation_id, r.envelope_id, r.state = 'held' as held,
            (c.reserved_minor - coalesce(c.actual_minor, 0))::text as back
       from public.model_calls c
       join public.reservations r on r.business_id = c.business_id and r.id = c.reservation_id
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where c.business_id = $1 and c.id = $2 and c.state in ('settled', 'released')
        and ((r.state = 'actual' and a.state <> 'settled')
          or (r.state = 'abandoned' and r.classified_cause = any($3::text[]))
          or (r.state in ('held', 'actual', 'abandoned') and exists (
                select 1 from public.budget_answers ba
                  join public.budget_asks k on k.business_id = ba.business_id and k.id = ba.ask_id
                 where ba.business_id = r.business_id and k.reservation_id = r.id
                   and ba.kind = 'top_up')))
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
