// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c2: the receipt of an observed effect. It is derived, not stored: every
// fact it names is already a row nobody can edit, so a receipt table would be
// a second copy to disagree with them. The chain runs one way, from the
// attempt to the decision that approved its version and to the effect the
// operation register holds under the attempt's derived identity.
//
// Only an observed attempt has a receipt. A staged intent (dispatched, never
// observed) reads as no receipt at all. The receipt carries facts and no
// operation: nothing on it undoes the effect. T2d: it names the settlement,
// read from the settled attempt and its reservation: the amount held, spent
// and released, or the hold alone while it is unpriced or an unknown liability.
// AW-08: `link` is the receipt link captured when the effect was observed, or
// null when none was kept (`receipt-link.ts`); a reader renders null as text.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { Settlement } from './budget.ts';

export interface Receipt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly decision: {
    readonly id: string;
    readonly gateId: string;
    readonly decidedByPersonId: string;
    readonly decidedAt: string;
  };
  readonly version: { readonly id: string; readonly number: number };
  readonly link: string | null;
  readonly effect: {
    readonly kind: string;
    readonly operationId: string;
    readonly commentId: string;
    readonly audience: string;
  };
  readonly settlement:
    | Exclude<Settlement, { readonly state: 'liability_unknown' }>
    | { readonly state: 'liability_unknown'; readonly heldMinor: number };
}

/** The task an attempt worked, in this business only: what the receipt's grant check is asked on. */
export async function receiptTask(tx: TenantQuery, attemptId: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly task_id: string }>(
    `select l.task_id from public.attempts att
       join public.leases l on l.business_id = att.business_id and l.id = att.lease_id
      where att.business_id = $1 and att.id = $2`,
    [tx.businessId, attemptId],
  );
  return rows[0]?.task_id;
}

/** The receipt of an observed attempt, or `undefined` when there is none to give. */
export async function readReceipt(
  tx: TenantQuery,
  attemptId: string,
  effectOperationId: string,
): Promise<Receipt | undefined> {
  const rows = await tx.query<{ readonly receipt: Receipt }>(
    `select json_build_object(
              'attemptId', att.id, 'taskId', l.task_id,
              'decision', json_build_object('id', d.id, 'gateId', d.gate_id,
                'decidedByPersonId', d.decided_by_person_id,
                'decidedAt', to_char(d.decided_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'version', json_build_object('id', ver.id, 'number', ver.version),
              'link', att.receipt_link,
              'effect', json_build_object('kind', step.kind, 'operationId', o.operation_id,
                'commentId', c.id, 'audience', c.data ->> 'audience'),
              'settlement', case when att.state = 'settled'
                then json_build_object('state', 'settled', 'heldMinor', res.held_minor,
                  'spentMinor', att.actual_minor, 'releasedMinor', res.held_minor - att.actual_minor)
                else json_build_object('state', case when att.state = 'liability_unknown'
                  then 'liability_unknown' else 'unpriced' end, 'heldMinor', res.held_minor)
                end) as receipt
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.leases l on l.business_id = att.business_id and l.id = att.lease_id
       join public.planned_steps step on step.business_id = att.business_id and step.id = att.step_id
       join public.proposal_versions ver on ver.business_id = att.business_id and ver.id = att.version_id
       join public.gate_decisions d on d.business_id = att.business_id
        and d.version_id = att.version_id and d.decision = 'approve'
       join public.operations o on o.business_id = att.business_id
        and o.actor_id = l.holder_actor_id and o.operation_id = $3 and o.outcome = 'applied'
       join public.records c on c.business_id = att.business_id
        and c.id = (o.result -> 'detail' ->> 'commentId')::uuid
      where att.business_id = $1 and att.id = $2 and att.observed
      order by d.seq desc
      limit 1`,
    [tx.businessId, attemptId, effectOperationId],
  );
  return rows[0]?.receipt;
}
