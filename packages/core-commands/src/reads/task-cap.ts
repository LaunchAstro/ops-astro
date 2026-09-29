// SPDX-License-Identifier: AGPL-3.0-only
//
// The cap an approval on a task draws on, in one place.
//
// A task with an open envelope draws on that envelope's cap; the runtime's
// decision refuses any other with `CAP_BINDING_MISMATCH`, and an envelope's
// currency is fixed to its cap's (migration 0024). A task with no envelope
// yet draws on the business's cap (`readBusinessCapId`). `task.decide` names
// the cap this way and `task.read` shows its currency this way, so the
// currency a reader is offered is the one a decision accepts, even after the
// business installs a newer cap while an older envelope is still open.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { readBusinessCapId } from '../../../core-runtime/src/index.ts';

/** The open envelope's cap for the task a gate is on, if there is one. */
async function envelopeCapOfGate(tx: TenantQuery, gateId: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly cap_id: string }>(
    `select e.cap_id
       from public.gates g
       join public.planned_runs r on r.business_id = g.business_id and r.id = g.run_id
       join public.task_envelopes e
         on e.business_id = r.business_id and e.task_id = r.task_id and e.state = 'open'
      where g.business_id = $1 and g.id = $2`,
    [tx.businessId, gateId],
  );
  return rows[0]?.cap_id;
}

/**
 * The cap a decision on this gate draws on. A gate this business cannot see
 * has no envelope here, so it falls through to the business's cap and the
 * decision answers for the gate itself, exactly as before.
 */
export async function decisionCapId(tx: TenantQuery, gateId: string): Promise<string | undefined> {
  return (await envelopeCapOfGate(tx, gateId)) ?? (await readBusinessCapId(tx));
}

/** The currency of the cap an approval on this task draws on, or null with no cap. */
export async function taskCapCurrency(tx: TenantQuery, taskId: string): Promise<string | null> {
  const rows = await tx.query<{ readonly currency: string }>(
    `select c.currency from public.budget_caps c
      where c.business_id = $1
        and c.id = coalesce(
          (select e.cap_id from public.task_envelopes e
            where e.business_id = $1 and e.task_id = $2 and e.state = 'open'),
          $3::uuid)`,
    [tx.businessId, taskId, (await readBusinessCapId(tx)) ?? null],
  );
  return rows[0]?.currency ?? null;
}
