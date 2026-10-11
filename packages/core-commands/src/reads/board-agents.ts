// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the board and the task (agent assignee ruling point 9): for
// each row served, the agent holding it, by name with its owner, and the
// agents the reader may hand it to. Asked only of the rows already served
// under the reader's grants, in two queries for the whole board rather than
// two per row; `task.read` asks it of its one task (`task-agents.ts`). An
// agent reader is sent neither.

import {
  AGENT_NAME_SQL,
  DELEGATION_STANDS,
  directableAgents,
  personSubjects,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { AgentAssigneeView, AgentOfferView } from '../../../core-wire/src/index.ts';

export interface RowAgents {
  readonly agent: AgentAssigneeView | null;
  readonly myAgents: readonly AgentOfferView[];
}

export const NO_AGENTS: RowAgents = { agent: null, myAgents: [] };

/** The agents the reader may hand a task to, whatever rows are served; none for an agent reader (null). */
export async function readerAgents(
  tx: TenantQuery,
  reader: string | null,
): Promise<readonly AgentOfferView[]> {
  return reader === null
    ? []
    : await directableAgents(tx, reader, await personSubjects(tx, reader));
}

/** Each served row's agent and the reader's choices for it; none for an agent reader (null). */
export async function readBoardAgents(
  tx: TenantQuery,
  taskIds: readonly string[],
  reader: string | null,
): Promise<ReadonlyMap<string, RowAgents>> {
  const found = new Map<string, RowAgents>();
  if (reader === null || taskIds.length === 0) return found;
  const myAgents = await readerAgents(tx, reader);
  for (const taskId of taskIds) found.set(taskId, { agent: null, myAgents });
  for (const [taskId, agent] of await heldAgents(tx, taskIds)) {
    found.set(taskId, { agent, myAgents });
  }
  return found;
}

/** The agent holding each row, and whether a run of it is in progress there. */
async function heldAgents(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<readonly (readonly [string, AgentAssigneeView])[]> {
  const rows = await tx.query<{
    readonly task_id: string;
    readonly agent_id: string;
    readonly name: string;
    readonly owner_id: string | null;
    readonly owner_name: string | null;
    readonly live: boolean;
    readonly run_state: 'waiting' | 'started' | null;
    readonly launched_at: Date | null;
  }>(
    `select r.id as task_id, a.id as agent_id, ${AGENT_NAME_SQL} as name,
            a.owner_person_id as owner_id, p.display_name as owner_name,
            exists (select 1 from public.delegations d
                     where d.business_id = r.business_id and d.agent_actor_id = a.id
                       and d.purpose_scope_id = r.id and ${DELEGATION_STANDS}) as live,
            run.state as run_state, run.launched_at
       from public.records r
       join public.actors a on a.business_id = r.business_id and a.id::text = r.data ->> 'agent'
       left join public.people p on p.business_id = a.business_id and p.id = a.owner_person_id
       -- The open launch of this agent on the task, while its delegation stands.
       left join lateral (
         select l.state, l.launched_at from public.task_launches l
           join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
          where l.business_id = r.business_id and l.task_id = r.id and l.agent_actor_id = a.id
            and l.state <> 'ended' and ${DELEGATION_STANDS}) run on true
      where r.business_id = $1 and r.id = any($2::uuid[])`,
    [tx.businessId, taskIds],
  );
  return rows.map((row) => [
    row.task_id,
    {
      agentId: row.agent_id,
      name: row.name,
      owner: row.owner_id === null ? null : { personId: row.owner_id, name: row.owner_name ?? '' },
      live: row.live,
      run:
        row.run_state === null || row.launched_at === null
          ? null
          : { state: row.run_state, launchedAt: row.launched_at.toISOString() },
    },
  ]);
}
