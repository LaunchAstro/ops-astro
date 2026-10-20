// SPDX-License-Identifier: AGPL-3.0-only
//
// The map a ticket belongs to, as a member's task detail names it for the
// link back to it.

import {
  readableTaskCondition,
  readableTaskParams,
  subjectsOf,
  type Session,
  type Subject,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { TaskMapLink } from '../../../core-wire/src/index.ts';
import { readClientFacts } from '../commands/task-content.ts';

/**
 * The map a ticket belongs to, or null: a live map the ticket is filed under
 * now, and only where the subjects' grants reach that map itself (a ticket's
 * grant never reaches up to its map). One statement reads the ticket's map
 * and judges the grant, so a map it has left, or one retyped, is not named.
 */
export async function readTicketMap(
  tx: TenantQuery,
  taskTypeId: string,
  ticketId: string,
  subjects: readonly Subject[],
): Promise<TaskMapLink | null> {
  const rows = await tx.query<TaskMapLink>(
    `select m.id, m.txt_1 as key, m.txt_4 as title
       from public.records t
       join public.records m on m.business_id = t.business_id and m.id = t.uuid_4
        and m.record_type_id = t.record_type_id
      where t.business_id = $1 and t.id = $2 and t.record_type_id = $3
        and coalesce(t.data ->> 'type', 'task') <> 'map'
        and m.deleted_at is null and m.data ->> 'type' = 'map'
        and ${readableTaskCondition('m', 4)}`,
    [tx.businessId, ticketId, taskTypeId, ...readableTaskParams(subjects)],
  );
  return rows[0] ?? null;
}

/** What a member's task detail adds: the Client field's facts and the ticket's map. */
export async function memberFacts(
  tx: TenantQuery,
  session: Session,
  spine: { readonly taskTypeId: string },
  taskId: string,
): Promise<Awaited<ReturnType<typeof readClientFacts>> & { map: TaskMapLink | null }> {
  const subjects = subjectsOf(session);
  return {
    ...(await readClientFacts(tx, taskId, subjects)),
    map: await readTicketMap(tx, spine.taskTypeId, taskId, subjects),
  };
}
