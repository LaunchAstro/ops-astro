// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a task is assigned to, as four eyes (T2g) asks it: its person assignee,
// the owner of the agent holding it (Assign to AI, the agent actor in the
// task's `agent` field), since an agent's work counts as its owner's, and, for
// one gate, the launcher whose Launch minted the delegation an agent made its
// proposal under (`proposal_versions.launch_delegation_id`): one who launched
// another person's agent is accountable for what it proposed, and signs none
// of it off. That last is kept on the proposal, so it holds once the launch
// ends, and is that proposal's alone: another lineage on the task is theirs
// to decide. A pickup's delegation names the person who authorised the run,
// who goes on to judge its output (AW-09), so only a Launch's is kept there.
// Asked of the task without a gate (a read of waiting tasks), a launcher is
// named only when they launched every pending gate, so none is left to them.
// `task.decide` refuses each of them the gate, so the inbox raises none of
// them a decision item and counts none a path to one. One statement for every
// caller, so the gate and the inbox never disagree.

import type { TenantQuery } from '../tenancy/database.ts';

/** The people four eyes refuses the task's gate (`gateId`), or all its pending gates; none when unassigned. */
export async function assignedPeople(
  tx: TenantQuery,
  taskId: string,
  gateId: string | null = null,
): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly person: string }>(
    `select r.uuid_2::text as person from public.records r
      where r.business_id = $1 and r.id = $2 and r.uuid_2 is not null
     union
     select a.owner_person_id::text from public.records r
       join public.actors a on a.business_id = r.business_id and a.id::text = r.data ->> 'agent'
      where r.business_id = $1 and r.id = $2 and a.owner_person_id is not null
     union
     -- Through the row, not by column name: a database upgraded only to an
     -- earlier migration (the upgrade-path suites decide on one) has no column.
     select d.delegate_person_id::text from public.proposal_lineages l
       join public.gates g on g.business_id = l.business_id and g.lineage_id = l.id
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
       join public.delegations d on d.business_id = v.business_id
        and d.id = (to_jsonb(v) ->> 'launch_delegation_id')::uuid
      where l.business_id = $1 and l.task_id = $2 and g.state = 'pending'
        and ($3::uuid is null or g.id = $3::uuid)
      group by d.delegate_person_id
     having count(*) = (select count(*) from public.proposal_lineages l
                          join public.gates g on g.business_id = l.business_id and g.lineage_id = l.id
                         where l.business_id = $1 and l.task_id = $2 and g.state = 'pending'
                           and ($3::uuid is null or g.id = $3::uuid))`,
    [tx.businessId, taskId, gateId],
  );
  return rows.map((row) => row.person);
}

/** Whether four eyes refuses this person the task's gate, or every pending one: `assignedPeople` names them. */
export async function assignedTo(
  tx: TenantQuery,
  taskId: string,
  personId: string,
  gateId: string | null = null,
): Promise<boolean> {
  return (await assignedPeople(tx, taskId, gateId)).includes(personId.toLowerCase());
}
