// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the board (agent assignee ruling point 9): for each row
// served, what `task.read` sends the same reader (`reads/task-agents.ts`), in
// two queries for the whole board rather than two per row. The agent holding
// a row is sent only when it is the reader's own delegation; the offers are
// the reader's own live delegations minted for that row. Both are asked only
// of the rows already served under the reader's grants, so a delegation on a
// task the reader cannot read is never looked at. Another person's
// delegations are never listed, counted or hinted.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { AgentAssigneeView, AgentOfferView } from '../../../core-wire/src/index.ts';

export interface RowAgents {
  readonly agent: AgentAssigneeView | null;
  readonly myAgents: readonly AgentOfferView[];
}

export const NO_AGENTS: RowAgents = { agent: null, myAgents: [] };

/** Each served row's agent when it is the reader's, and the reader's own agents for it; none for an agent reader. */
export async function readBoardAgents(
  tx: TenantQuery,
  taskIds: readonly string[],
  reader: string | null,
): Promise<ReadonlyMap<string, RowAgents>> {
  const found = new Map<string, RowAgents>();
  if (reader === null || taskIds.length === 0) return found;
  const at = (taskId: string): RowAgents => found.get(taskId) ?? NO_AGENTS;
  for (const [taskId, agent] of await heldByReader(tx, taskIds, reader)) {
    found.set(taskId, { ...at(taskId), agent });
  }
  for (const row of await offeredToReader(tx, taskIds, reader)) {
    const was = at(row.task_id);
    const offer = { delegationId: row.id, purpose: row.purpose };
    found.set(row.task_id, { ...was, myAgents: [...was.myAgents, offer] });
  }
  return found;
}

/** The delegation holding each row, where it is the reader's own. */
async function heldByReader(
  tx: TenantQuery,
  taskIds: readonly string[],
  reader: string,
): Promise<readonly (readonly [string, AgentAssigneeView])[]> {
  const rows = await tx.query<{
    readonly task_id: string;
    readonly id: string;
    readonly purpose: string;
    readonly person_id: string;
    readonly person_name: string | null;
    readonly live: boolean;
  }>(
    `select r.id as task_id, d.id, d.purpose, d.delegate_person_id as person_id,
            p.display_name as person_name,
            (d.revoked_at is null and d.settled_at is null and d.expires_at > now()) as live
       from public.records r
       join public.delegations d on d.business_id = r.business_id and d.id::text = r.data ->> 'agent'
       left join public.people p on p.business_id = d.business_id and p.id = d.delegate_person_id
      where r.business_id = $1 and r.id = any($2::uuid[]) and d.delegate_person_id = $3`,
    [tx.businessId, taskIds, reader],
  );
  return rows.map((row) => [
    row.task_id,
    {
      delegationId: row.id,
      purpose: row.purpose,
      accountable: { personId: row.person_id, name: row.person_name ?? '' },
      live: row.live,
    },
  ]);
}

/** The reader's own live delegations minted for the rows, in purpose order. */
async function offeredToReader(
  tx: TenantQuery,
  taskIds: readonly string[],
  reader: string,
): Promise<readonly { readonly task_id: string; readonly id: string; readonly purpose: string }[]> {
  return await tx.query(
    `select purpose_scope_id as task_id, id, purpose from public.delegations
      where business_id = $1 and delegate_person_id = $2 and purpose_scope_id = any($3::uuid[])
        and revoked_at is null and settled_at is null and expires_at > now()
      order by purpose, id`,
    [tx.businessId, reader, taskIds],
  );
}
