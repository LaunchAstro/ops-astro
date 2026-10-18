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
  readableTaskIds,
  readableTaskParams,
  UNANSWERED_MINUTES,
  type Subject,
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

/**
 * Each served row's agent and the reader's choices for it; none for an agent
 * reader (null). A row `readers` can no longer read has no agent read for it;
 * null `readers` for a caller that has judged reach already.
 */
export async function readBoardAgents(
  tx: TenantQuery,
  taskIds: readonly string[],
  reader: string | null,
  readers: readonly Subject[] | null,
): Promise<ReadonlyMap<string, RowAgents>> {
  const found = new Map<string, RowAgents>();
  if (reader === null || taskIds.length === 0) return found;
  const myAgents = await readerAgents(tx, reader);
  for (const taskId of taskIds) found.set(taskId, { agent: null, myAgents });
  for (const [taskId, agent] of await heldAgents(tx, taskIds, readers)) {
    found.set(taskId, { agent, myAgents });
  }
  return found;
}

/**
 * SQL: the open launch `run`'s state, `unanswered` while it still waits once
 * `$5` minutes have passed since it was launched (#1710), judged when the
 * read's statement runs.
 */
const RUN_STATE = `case when run.state = 'waiting'
                        and run.launched_at <= statement_timestamp() - make_interval(mins => $5)
                       then 'unanswered' else run.state end`;

/** The agent holding each row, and whether a run of it is in progress there. */
async function heldAgents(
  tx: TenantQuery,
  taskIds: readonly string[],
  readers: readonly Subject[] | null,
): Promise<readonly (readonly [string, AgentAssigneeView])[]> {
  const rows = await tx.query<{
    readonly task_id: string;
    readonly agent_id: string;
    readonly name: string;
    readonly owner_id: string | null;
    readonly owner_name: string | null;
    readonly live: boolean;
    readonly run_state: 'waiting' | 'unanswered' | 'started' | null;
    readonly launched_at: Date | null;
  }>(
    `select r.id as task_id, a.id as agent_id, ${AGENT_NAME_SQL} as name,
            a.owner_person_id as owner_id, p.display_name as owner_name,
            exists (select 1 from public.delegations d
                     where d.business_id = r.business_id and d.agent_actor_id = a.id
                       and d.purpose_scope_id = r.id and ${DELEGATION_STANDS}) as live,
            ${RUN_STATE} as run_state, run.launched_at
       from public.records r
       join public.actors a on a.business_id = r.business_id and a.id::text = r.data ->> 'agent'
       left join public.people p on p.business_id = a.business_id and p.id = a.owner_person_id
       -- The open launch of this agent on the task, while its delegation stands.
       left join lateral (
         select l.state, l.launched_at from public.task_launches l
           join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
          where l.business_id = r.business_id and l.task_id = r.id and l.agent_actor_id = a.id
            and l.state <> 'ended' and ${DELEGATION_STANDS}) run on true
      where r.business_id = $1 and r.id = any(${readableTaskIds('$2::uuid[]', 3)})`,
    [tx.businessId, taskIds, ...readableTaskParams(readers), UNANSWERED_MINUTES],
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
