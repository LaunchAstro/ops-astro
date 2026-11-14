// SPDX-License-Identifier: AGPL-3.0-only
//
// A request to delete a task (#2351) in the inbox (#2360). The request's own
// command raises the item in its transaction, under the task row lock the
// envelope takes, and the answer clears it in its own, so an item exists
// exactly while its request is open and committed.
//
// Who is told: an agent asks for a person (`requested_for_person_id`), and
// that person is told when they hold `task:decide` on the task, since only a
// decide holder can answer. Otherwise, and when a person asked for
// themselves, the task's decide holders are told, the asker aside. A decide
// grant on a ticket's covering map answers the ticket too (W12, as the
// command's own check admits it), so its holders count. Nobody outside the
// business is: every statement binds `tx.businessId`.
//
// A request lapses by the clock, with no command to close its item, so an
// open item whose request is no longer open is neither shown nor counted
// (`LIVE_DELETE_REQUEST`), and it is withdrawn when the lapse is recorded.

import { grantHolders } from '../authority/grant-reach.ts';
import { wayfinderFacts } from '../tasks/wayfinder.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { raiseInboxItem } from './items.ts';

/**
 * Item `i` is not a delete request's, or its request is still open now. The
 * inbox list, its owed count and the unattended list ask it of every open item.
 */
export const LIVE_DELETE_REQUEST = `(i.reason <> 'delete_request' or exists (
         select 1 from public.task_delete_requests q
          where q.business_id = i.business_id and q.id = i.fact_id
            and q.answer is null and q.expires_at > clock_timestamp()))`;

/** Who can answer the task's request: decide on the task, or on the map that covers it (W12). */
async function decideHolders(tx: TenantQuery, taskId: string): Promise<readonly string[]> {
  const on = (id: string) =>
    grantHolders(tx, { collection: 'task', action: 'decide', scope: { kind: 'record', id } });
  const map = (await wayfinderFacts(tx, taskId))?.mapId ?? null;
  const holders = await on(taskId);
  if (map === null || map === taskId) return holders;
  return [...new Set([...holders, ...(await on(map))])].toSorted();
}

/** The people told of a new request, read in the request's own transaction. */
async function toldOf(
  tx: TenantQuery,
  request: { readonly taskId: string; readonly requestId: string },
): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly forPerson: string; readonly byAgent: boolean }>(
    `select q.requested_for_person_id as "forPerson", a.kind <> 'person' as "byAgent"
       from public.task_delete_requests q
       join public.actors a on a.business_id = q.business_id and a.id = q.requested_by_actor_id
      where q.business_id = $1 and q.id = $2 and q.task_id = $3`,
    [tx.businessId, request.requestId, request.taskId],
  );
  const asked = rows[0];
  if (asked === undefined) throw new Error('raiseDeleteRequest: the request is not here');
  const holders = await decideHolders(tx, request.taskId);
  if (asked.byAgent && holders.includes(asked.forPerson)) return [asked.forPerson];
  return holders.filter((person) => person !== asked.forPerson);
}

/** Raise one owed `delete_request` item per person told of the new request. */
export async function raiseDeleteRequest(
  tx: TenantQuery,
  request: { readonly taskId: string; readonly requestId: string },
): Promise<void> {
  for (const person of await toldOf(tx, request)) {
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person,
      subjectRecordId: request.taskId,
      reason: 'delete_request',
      fact: { kind: 'delete_request', id: request.requestId },
    });
  }
}

/**
 * Clear every open item on the answered request, naming who answered and, as
 * the closing record, the request itself, whose row now holds the answer (as
 * `clearDecision` names its decision row).
 */
export async function clearDeleteRequest(
  tx: TenantQuery,
  answered: {
    readonly taskId: string;
    readonly requestId: string;
    readonly personId: string;
  },
): Promise<number> {
  const cleared = await tx.query<{ readonly id: string }>(
    `update public.inbox_items
        set work_state = 'cleared', closed_at = now(),
            closed_by_person_id = $4, closed_by_operation_id = $3
      where business_id = $1 and subject_record_id = $2 and reason = 'delete_request'
        and fact_kind = 'delete_request' and fact_id = $3 and work_state = 'open'
      returning id`,
    [tx.businessId, answered.taskId, answered.requestId, answered.personId],
  );
  return cleared.length;
}

/** Withdraw the open items on the task's requests that are no longer open. Withdrawn names nobody. */
export async function withdrawLapsedDeleteRequests(
  tx: TenantQuery,
  taskId: string,
): Promise<number> {
  const withdrawn = await tx.query<{ readonly id: string }>(
    `update public.inbox_items i set work_state = 'withdrawn', closed_at = now()
      where i.business_id = $1 and i.subject_record_id = $2 and i.work_state = 'open'
        and not ${LIVE_DELETE_REQUEST}
      returning i.id`,
    [tx.businessId, taskId],
  );
  return withdrawn.length;
}
