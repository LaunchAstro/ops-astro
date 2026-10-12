// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a task is assigned to, as four eyes (T2g) asks it: its person assignee,
// the owner of the agent holding it (Assign to AI, the agent actor in the
// task's `agent` field), and, for one gate, the owner of the agent that
// proposed its version (`proposal_versions.proposed_by_actor_id`) and the
// launcher whose Launch minted the delegation it proposed under
// (`proposal_versions.launch_delegation_id`). An agent's work counts as its
// owner's, and one who launched another person's agent is accountable for
// what it proposed; both are kept on the proposal, so they hold whoever holds
// the task later and once the launch ends, and are that proposal's alone:
// another lineage on the task is theirs to decide. A pickup's delegation
// names the person who authorised the run, who goes on to judge its output
// (AW-09), so only a Launch's is kept there. Asked of the task without a gate
// (an assignment withdrawing decision items), the proposer's owner or launcher
// is named only when they are so for every gate still open (live lineage,
// current version, before its deadline), so none is left to them. `task.decide` refuses each
// of them the gate, so the inbox raises none of them a decision item and
// counts none a path to one. One statement for every caller, so the gate and
// the inbox never disagree.

import { readableTaskIds, readableTaskParams } from '../authority/readable-scope.ts';
import type { Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/** The people four eyes refuses the task's gate (`gateId`), or all its pending gates; none when unassigned. */
export async function assignedPeople(
  tx: TenantQuery,
  taskId: string,
  gateId: string | null = null,
): Promise<readonly string[]> {
  return (await assigneesIfReadable(tx, taskId, gateId, null)) ?? [];
}

/**
 * `assignedPeople`, asked in the same statement as whether `readers` may read
 * the task now (`readableTaskIds`): undefined when they may not, and then
 * nothing of the task is read. Null `readers` asks no reach.
 */
export async function assigneesIfReadable(
  tx: TenantQuery,
  taskId: string,
  gateId: string | null,
  readers: readonly Subject[] | null,
): Promise<readonly string[] | undefined> {
  const rows = await tx.query<{ readonly readable: boolean; readonly person: string | null }>(
    `with reach as (
       select $2::uuid = any(${readableTaskIds('array[$2::uuid]', 4)}) as readable),
     gate as (
       -- Through the row, not by column name: a database upgraded only to an
       -- earlier migration (the upgrade-path suites decide on one) has no column.
       select g.id, v.proposed_by_actor_id as proposer,
              (to_jsonb(v) ->> 'launch_delegation_id')::uuid as launch
         from public.proposal_lineages l
         join public.gates g on g.business_id = l.business_id and g.lineage_id = l.id
         join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
        where l.business_id = $1 and l.task_id = $2 and g.state = 'pending'
          and (select readable from reach)
          and (g.id = $3::uuid or ($3::uuid is null and l.state = 'live'
               and v.superseded_at is null and g.expires_at > statement_timestamp()))),
     people as (
     select r.uuid_2::text as person from public.records r
      where r.business_id = $1 and r.id = $2 and r.uuid_2 is not null
        and (select readable from reach)
     union
     select a.owner_person_id::text from public.records r
       join public.actors a on a.business_id = r.business_id and a.id::text = r.data ->> 'agent'
      where r.business_id = $1 and r.id = $2 and a.owner_person_id is not null
        and (select readable from reach)
     union
     select x.person::text from gate
       left join public.actors a on a.business_id = $1 and a.id = gate.proposer
       left join public.delegations d on d.business_id = $1 and d.id = gate.launch
      cross join lateral (values (a.owner_person_id), (d.delegate_person_id)) as x (person)
      where x.person is not null
      group by x.person
     having count(distinct gate.id) = (select count(*) from gate))
     select reach.readable, people.person from reach left join people on true`,
    [tx.businessId, taskId, gateId, ...readableTaskParams(readers)],
  );
  if (rows[0]?.readable !== true) return undefined;
  return rows.flatMap((row) => (row.person === null ? [] : [row.person]));
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
