// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-2's decision item (MP-7-3): a grilling or prototype ticket on its map's
// frontier owes the map's owner a decision. The frontier is the read model
// 0281's triggers keep in the same transaction as every write to a map's
// tickets, links and parts, so a command that can move a ticket onto it calls
// this after its write and the item exists exactly when that write commits.
//
// Once per ticket and owner: an item already raised, open or cleared, is not
// raised again by a later write that leaves the ticket on the frontier. Only
// the owner is raised one (the frontier ticket's owner rule, `refuseUnlessOwner`),
// only for this map's tickets, and only in the transaction's own business.

import { raiseInboxItem, wayfinderFacts } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The owner's decision types; research, task and build tickets owe nobody a decision. */
const DECISION_TYPES = ['grilling', 'prototype'];

/**
 * Raise the map owner's decision item for each grilling or prototype ticket
 * now on the frontier of the map `recordId` is (or is filed under) that has
 * never had one. A task outside any map, or a map with no owner, raises nothing.
 */
export async function raiseFrontierDecisions(tx: TenantQuery, recordId: string): Promise<void> {
  const facts = await wayfinderFacts(tx, recordId);
  if (facts?.mapId === null || facts?.mapId === undefined || facts.mapOwner === null) return;
  const owed = await tx.query<{ readonly ticket: string }>(
    `select f.ticket_id::text as ticket
       from public.map_frontier f
       join public.records r on r.business_id = f.business_id and r.id = f.ticket_id
      where f.business_id = $1 and f.map_id = $2 and r.data ->> 'type' = any($4::text[])
        and not exists (
          select 1 from public.inbox_items i
           where i.business_id = f.business_id and i.recipient_person_id = $3
             and i.subject_record_id = f.ticket_id and i.reason = 'decision'
             and i.fact_kind = 'record' and i.fact_id = f.ticket_id)
      order by f.position`,
    [tx.businessId, facts.mapId, facts.mapOwner, DECISION_TYPES],
  );
  for (const { ticket } of owed) {
    // oxlint-disable-next-line no-await-in-loop -- one item after another, as raiseDecision does
    await raiseInboxItem(tx, {
      recipientPersonId: facts.mapOwner,
      subjectRecordId: ticket,
      reason: 'decision',
      fact: { kind: 'record', id: ticket },
    });
  }
}
