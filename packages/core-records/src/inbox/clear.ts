// SPDX-License-Identifier: AGPL-3.0-only
//
// Clearing (INB-1c). A decision item closes inside the decision's own
// transaction: the command-layer decision handler calls `clearDecision` after
// the decision operation returns ok and before its applied result is built, so
// the decision row, the gate's state and the item's closure commit or roll
// back together. Nothing here writes a gate, a decision or a proposal, and no
// trigger or constraint lands on their tables (RN-12): the gate engine is read,
// never touched.
//
// Clearing throws rather than returning a refusal, because a refusal the
// envelope retains would commit the decision with its items still open.
//
// Expiry (the rule this part sets). A pending gate past its expiry stays
// pending in storage, and its items stay open and owed until a decision, a
// superseding version or the end of its lineage closes them. Nothing here, no
// setting and no read, turns an expired gate into a decision or an item into a
// cleared one.

import type { TenantQuery } from '../tenancy/database.ts';

/**
 * Close every open decision item on a decided gate and about that gate's own
 * task, naming the person the durable decision names and the decision itself
 * as the operation that closed it. The decider is read from the decision row,
 * never taken from the caller, so there is no clearing without a decision. A
 * replay of the same operation returns its stored answer and never reaches
 * here twice; a second decision on the same gate is refused before it does.
 */
export async function clearDecision(
  tx: TenantQuery,
  decided: { readonly gateId: string; readonly decisionId: string },
): Promise<number> {
  const decisions = await tx.query<{ readonly decider: string }>(
    `select decided_by_person_id as decider from public.gate_decisions
      where business_id = $1 and id = $2 and gate_id = $3`,
    [tx.businessId, decided.decisionId, decided.gateId],
  );
  const decider = decisions[0]?.decider;
  if (decider === undefined) {
    throw new Error('clearDecision: no decision by that identity on this gate');
  }
  // The gate's own task, through its lineage: an item whose subject is some
  // other task (another client's, say) is not this decision's, even when its
  // pointer names this gate.
  const cleared = await tx.query<{ readonly id: string }>(
    `update public.inbox_items i
        set work_state = 'cleared', closed_at = now(),
            closed_by_person_id = $3, closed_by_operation_id = $4
       from public.gates g
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where i.business_id = $1 and i.reason = 'decision' and i.fact_kind = 'gate'
        and i.fact_id = $2 and i.work_state = 'open'
        and g.business_id = i.business_id and g.id = i.fact_id
        and i.subject_record_id = l.task_id
      returning i.id`,
    [tx.businessId, decided.gateId, decider, decided.decisionId],
  );
  return cleared.length;
}

/**
 * Withdraw the open decision items on a task whose gate can no longer be
 * decided: a superseded version's gate, or a still-pending gate whose lineage
 * was cancelled or rejected. Withdrawn names nobody, because nobody decided.
 * An expired gate is still pending on a live lineage and is left open.
 */
export async function withdrawEndedGates(tx: TenantQuery, taskId: string): Promise<number> {
  const withdrawn = await tx.query<{ readonly id: string }>(
    `update public.inbox_items i set work_state = 'withdrawn', closed_at = now()
       from public.gates g
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where i.business_id = $1 and i.subject_record_id = $2 and i.reason = 'decision'
        and i.fact_kind = 'gate' and i.work_state = 'open'
        and g.business_id = i.business_id and g.id = i.fact_id
        and l.task_id = i.subject_record_id
        and (g.state = 'superseded' or (g.state = 'pending' and l.state <> 'live'))
      returning i.id`,
    [tx.businessId, taskId],
  );
  return withdrawn.length;
}
