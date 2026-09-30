// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent assignee as `task.read` sends it (Assign to AI): the delegation
// holding the task with the person accountable for it, and the reader's own
// live delegations that reach the task, which is all the Assign to AI control
// offers. Another person's delegations are never listed, counted or hinted.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { AgentAssigneeView, AgentOfferView } from '../../../core-wire/src/index.ts';

/** The task's agent, and the reader's own agents for it; neither for an agent reader. */
export async function readTaskAgents(
  tx: TenantQuery,
  recordId: string,
  reader: string | null,
): Promise<{
  readonly agent: AgentAssigneeView | null;
  readonly myAgents: readonly AgentOfferView[];
}> {
  // An agent reader is sent neither: the delegation holding the task may be
  // another person's, and an agent never sees another person's delegations.
  if (reader === null) return { agent: null, myAgents: [] };
  const held = await tx.query<{
    readonly id: string;
    readonly purpose: string;
    readonly person_id: string;
    readonly person_name: string | null;
    readonly live: boolean;
  }>(
    `select d.id, d.purpose, d.delegate_person_id as person_id, p.display_name as person_name,
            (d.revoked_at is null and d.settled_at is null and d.expires_at > now()) as live
       from public.records r
       join public.delegations d on d.business_id = r.business_id and d.id::text = r.data ->> 'agent'
       left join public.people p on p.business_id = d.business_id and p.id = d.delegate_person_id
      where r.business_id = $1 and r.id = $2`,
    [tx.businessId, recordId],
  );
  const row = held[0];
  const agent =
    row === undefined
      ? null
      : {
          delegationId: row.id,
          purpose: row.purpose,
          accountable: { personId: row.person_id, name: row.person_name ?? '' },
          live: row.live,
        };
  const mine = await tx.query<{ readonly id: string; readonly purpose: string }>(
    `select id, purpose from public.delegations
      where business_id = $1 and delegate_person_id = $2 and purpose_scope_id = $3
        and revoked_at is null and settled_at is null and expires_at > now()
      order by purpose, id`,
    [tx.businessId, reader, recordId],
  );
  return { agent, myAgents: mine.map((one) => ({ delegationId: one.id, purpose: one.purpose })) };
}
