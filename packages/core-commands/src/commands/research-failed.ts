// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 "Twice failed, it stops, reports on the ticket and raises one inbox
// item to the map's owner." Called by `task.handback` after a failed lease
// settles, in its transaction: a system write under the worker lease, not a
// person's grant. The launcher's own item on each failed run is INB-1's
// (`raiseRunSettled`); this adds the second failure's report and the owner's
// item, once. Nothing starts a run again: a research run is started by a
// person (WF-7) and the map's owner decides what happens next.

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
  "The map's owner has been asked to look before it runs again.";

/**
 * A failed handback on the ticket: on its second failed run, while it is a
 * research ticket, a system comment on the ticket and one waiting item to the
 * map's owner, both in the handback's transaction. Settled failures only: a
 * report the runtime retained after a refusal is not a run that failed.
 */
export async function researchFailed(
  tx: TenantQuery,
  failed: { readonly taskId: string; readonly leaseId: string },
): Promise<void> {
  const facts = await wayfinderFacts(tx, failed.taskId);
  if (facts?.type !== 'research') return;
  if ((await failedRuns(tx, failed.taskId)) !== TWICE) return;
  const author = await holderOf(tx, failed.leaseId);
  const commentTypeId = await commentType(tx);
  if (commentTypeId !== undefined) {
    await writeComment(tx, commentTypeId, {
      taskId: failed.taskId,
      authorActorId: author,
      commentType: 'system',
      audience: 'internal',
      body: REPORT,
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

/** The ticket's settled failed handbacks, this one included. */
async function failedRuns(tx: TenantQuery, taskId: string): Promise<number> {
  const rows = await tx.query<{ readonly n: number }>(
    `select count(*)::int as n
       from public.handback_reports h
       join public.leases l on l.business_id = h.business_id and l.id = h.lease_id
      where h.business_id = $1 and l.task_id = $2
        and h.disposition = 'settled' and h.outcome = 'failed'`,
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
