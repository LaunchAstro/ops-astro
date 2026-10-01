// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 "Twice failed, it stops, reports on the ticket and raises one inbox
// item to the map's owner." Called by `task.handback` after a failed lease
// settles, in its transaction: a system write under the worker lease, not a
// person's grant. The launcher's own item on each failed run is INB-1's
// (`raiseRunSettled`); this adds the second failure's report and the owner's
// item, once per ask. It stops: while that item is open, a start waits on the
// map's owner (`research-run.ts`), whose own start is their decision and
// clears it. Twice is counted since the owner's last item closed, so two more
// failures after their decision ask again.

import {
  COMMENT_TYPE_KEY,
  raiseInboxItem,
  wayfinderFacts,
  writeComment,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The failures that make a research ticket stop and ask its map's owner. */
const TWICE = 2;

const REPORT =
  'Research stopped: the run on this ticket failed twice. ' +
  "The map's owner has been asked to look, and the next run waits on them.";

const UNASKED =
  'The run on this ticket failed twice. ' +
  "It has no map's owner to ask, so no one has been asked to look.";

/** The owner's item: about the ticket itself, waiting on their move. */
const ASK = `subject_record_id = $2 and reason = 'waiting_run'
  and fact_kind = 'record' and fact_id = $2`;

/**
 * A failed handback on the ticket: on its second failed run since the map's
 * owner was last asked, while it is a research ticket and no ask is open, a
 * system comment on the ticket and one waiting item to the map's owner, both
 * in the handback's transaction. Settled failures only: a report the runtime
 * retained after a refusal is not a run that failed. The comment is the lease
 * holder's: the codebase has no system actor for writes under a lease.
 */
export async function researchFailed(
  tx: TenantQuery,
  failed: { readonly taskId: string; readonly leaseId: string },
): Promise<void> {
  const facts = await wayfinderFacts(tx, failed.taskId);
  if (facts?.type !== 'research') return;
  if ((await openAsk(tx, failed.taskId)) !== undefined) return;
  if ((await failuresSinceAsked(tx, failed.taskId)) !== TWICE) return;
  const author = await holderOf(tx, failed.leaseId);
  const commentTypeId = await commentType(tx);
  if (commentTypeId !== undefined) {
    await writeComment(tx, commentTypeId, {
      taskId: failed.taskId,
      authorActorId: author,
      commentType: 'system',
      audience: 'internal',
      body: facts.mapOwner === null ? UNASKED : REPORT,
      source: 'automation',
    });
  }
  if (facts.mapOwner === null) return;
  await raiseInboxItem(tx, {
    recipientPersonId: facts.mapOwner,
    subjectRecordId: failed.taskId,
    reason: 'waiting_run',
    fact: { kind: 'record', id: failed.taskId },
  });
}

/** The person an open ask on the ticket waits on; undefined when none is open. */
export async function openAsk(tx: TenantQuery, taskId: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly recipient: string }>(
    `select recipient_person_id as recipient from public.inbox_items
      where business_id = $1 and ${ASK} and work_state = 'open'
      order by raised_at limit 1`,
    [tx.businessId, taskId],
  );
  return rows[0]?.recipient;
}

/** The map owner's start is their decision: the open ask on the ticket clears, naming them. */
export async function clearAsk(tx: TenantQuery, taskId: string, owner: string): Promise<void> {
  await tx.query(
    `update public.inbox_items set work_state = 'cleared', closed_at = now(),
            closed_by_person_id = $3
      where business_id = $1 and ${ASK} and work_state = 'open'`,
    [tx.businessId, taskId, owner],
  );
}

/**
 * The ticket's settled failed handbacks since its last ask closed (or ever,
 * if it has had none), this one included. Called with no ask open.
 */
async function failuresSinceAsked(tx: TenantQuery, taskId: string): Promise<number> {
  const rows = await tx.query<{ readonly n: number }>(
    `select count(*)::int as n
       from public.handback_reports h
       join public.leases l on l.business_id = h.business_id and l.id = h.lease_id
      where h.business_id = $1 and l.task_id = $2
        and h.disposition = 'settled' and h.outcome = 'failed'
        and h.created_at > coalesce(
          (select max(closed_at) from public.inbox_items where business_id = $1 and ${ASK}),
          '-infinity')`,
    [tx.businessId, taskId],
  );
  return rows[0]?.n ?? 0;
}

/** The actor that held the lease: the run's own voice on the ticket. */
async function holderOf(tx: TenantQuery, leaseId: string): Promise<string> {
  const rows = await tx.query<{ readonly holder: string }>(
    `select holder_actor_id as holder from public.leases where business_id = $1 and id = $2`,
    [tx.businessId, leaseId],
  );
  const holder = rows[0]?.holder;
  if (holder === undefined) throw new Error('researchFailed: the settled lease is not here');
  return holder;
}

/** The business's comment type; a business installed before comments has none. */
async function commentType(tx: TenantQuery): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.record_types where business_id = $1 and key = $2`,
    [tx.businessId, COMMENT_TYPE_KEY],
  );
  return rows[0]?.id;
}
