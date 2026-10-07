// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a task is assigned to, as four eyes (T2g) asks it: its person assignee,
// and the person whose agent holds it (Assign to AI, the delegation in the
// task's `agent` field), since an agent assignee counts as its delegating
// person. `task.decide` refuses each of them the task's gate, so the inbox
// raises neither a decision item and counts neither a path to one. One
// statement for every caller, so the gate and the inbox never disagree.

import type { TenantQuery } from '../tenancy/database.ts';

/** The people the task is assigned to, read in the caller's transaction; none when unassigned. */
export async function assignedPeople(tx: TenantQuery, taskId: string): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly person: string }>(
    `select r.uuid_2::text as person from public.records r
      where r.business_id = $1 and r.id = $2 and r.uuid_2 is not null
     union
     select d.delegate_person_id::text from public.records r
       join public.delegations d
         on d.business_id = r.business_id and d.id::text = r.data ->> 'agent'
      where r.business_id = $1 and r.id = $2`,
    [tx.businessId, taskId],
  );
  return rows.map((row) => row.person);
}

/** Whether the task is assigned to this person, or to their agent. */
export async function assignedTo(
  tx: TenantQuery,
  taskId: string,
  personId: string,
): Promise<boolean> {
  return (await assignedPeople(tx, taskId)).includes(personId.toLowerCase());
}
