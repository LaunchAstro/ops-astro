// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's open request to delete it (#2351), as its page shows it: who asked,
// why, and when it lapses. A lapsed request is not open, so it is not sent.
// It is the team's to answer, so only a reader inside the business is sent it.

import { AGENT_NAME_SQL } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { DeleteRequestView } from '../../../core-wire/src/index.ts';

export async function openDeleteRequest(
  tx: TenantQuery,
  taskId: string,
): Promise<DeleteRequestView | null> {
  const rows = await tx.query<{
    readonly id: string;
    readonly reason: string;
    readonly by_agent: boolean;
    readonly name: string | null;
    readonly requested_at: Date;
    readonly expires_at: Date;
  }>(
    `select q.id, q.reason, a.kind = 'agent' as by_agent,
            case when a.kind = 'person' then p.display_name else ${AGENT_NAME_SQL} end as name,
            q.requested_at, q.expires_at
       from public.task_delete_requests q
       join public.actors a on a.business_id = q.business_id and a.id = q.requested_by_actor_id
       left join public.people p on p.business_id = a.business_id and p.id = a.person_id
      where q.business_id = $1 and q.task_id = $2 and q.answer is null
        and q.expires_at > clock_timestamp()`,
    [tx.businessId, taskId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    reason: row.reason,
    byAgent: row.by_agent,
    requestedBy: row.name ?? '',
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
