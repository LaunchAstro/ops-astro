// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox read and the owed count (INB-1d). One permission-checked read: the
// caller's own items, each with its access derived now from their live grants
// in the read's own query (`readInboxItems`): every open item, and the newest
// page of closed ones about a task they read. The count is one query under the
// same rule (`countOwedItems`); every open item is on the list, so the two
// cannot disagree, and neither waits on the worker nor grows with history.
//
// Counted means open, owed and readable. Read is not done (reading changes
// nothing), delivered is not seen (the last attempt and the attention row are
// separate fields), and withheld is not gone. A withheld item, about a task the
// caller holds no read on, is not listed at all: its identity, reason and times
// would say that another client's task exists. It stays stored and comes back
// at the first read after access returns. A gone item, about a trashed task
// the caller still holds read on, is listed as gone and names nothing of the
// task or the fact it points at.

import {
  countOwedItems,
  readInboxItems,
  readUnattended,
  type InboxItem,
  type UnattendedItem,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { InboxEntry, PersonView } from '../../../core-wire/src/index.ts';

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

function entryOf(item: InboxItem): InboxEntry {
  const readable = item.access === 'readable';
  return {
    id: item.id,
    reason: item.reason,
    workState: item.workState,
    access: item.access,
    owed: item.owed,
    counted: readable && item.owed && item.workState === 'open',
    raisedAt: item.raisedAt.toISOString(),
    closedAt: iso(item.closedAt),
    seenAt: iso(item.seenAt),
    lastDelivery: item.lastDelivery,
    ...(readable
      ? {
          subjectRecordId: item.subjectRecordId,
          factKind: item.factKind,
          factId: item.factId,
          closedByPersonId: item.closedByPersonId,
          ...(item.alert === null ? {} : { alert: item.alert }),
        }
      : {}),
  };
}

/**
 * The caller's own inbox, oldest raised first, as `readInboxItems` orders it.
 * A readable entry is named in the same transaction: its task's key and title,
 * and who closed it. The item stores neither, so a renamed task reads renamed.
 */
export async function readInbox(tx: TenantQuery, personId: string): Promise<readonly InboxEntry[]> {
  const items = await readInboxItems(tx, personId);
  const listed = items.filter((item) => item.access !== 'withheld').map((item) => entryOf(item));
  return await named(tx, listed);
}

/** The owed count: the list's counted entries, counted in one query under the same rule. */
export async function countOwed(tx: TenantQuery, personId: string): Promise<number> {
  return await countOwedItems(tx, personId);
}

async function named(
  tx: TenantQuery,
  entries: readonly InboxEntry[],
): Promise<readonly InboxEntry[]> {
  const readable = entries.filter((entry) => entry.access === 'readable');
  const taskIds = [...new Set(readable.map((entry) => entry.subjectRecordId ?? ''))];
  const deciderIds = [...new Set(readable.flatMap((entry) => entry.closedByPersonId ?? []))];
  if (taskIds.length === 0) return entries;
  const tasks = new Map(
    (
      await tx.query<{
        readonly id: string;
        readonly key: string | null;
        readonly title: string | null;
      }>(
        `select id, txt_1 as key, txt_4 as title from public.records
          where business_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
        [tx.businessId, taskIds],
      )
    ).map((row) => [row.id, { key: row.key ?? '', title: row.title }] as const),
  );
  const people = new Map<string, PersonView>(
    deciderIds.length === 0
      ? []
      : (
          await tx.query<{ readonly id: string; readonly name: string }>(
            `select id, display_name as name from public.people
              where business_id = $1 and id = any($2::uuid[])`,
            [tx.businessId, deciderIds],
          )
        ).map((row) => [row.id, { personId: row.id, name: row.name }] as const),
  );
  return entries.map((entry) => {
    if (entry.access !== 'readable') return entry;
    const task = tasks.get(entry.subjectRecordId ?? '');
    const decider = entry.closedByPersonId ?? null;
    return {
      ...entry,
      ...(task === undefined ? {} : { task }),
      closedBy: decider === null ? null : (people.get(decider) ?? null),
    };
  });
}

/** An item no path reaches (INB-1e), as the operations view is shown it. */
export type UnattendedEntry = Omit<UnattendedItem, 'raisedAt'> & { readonly raisedAt: string };

/**
 * The business's unattended items whose task the caller can read: the list
 * the operations view (C55) will show, on the API and the command line until
 * then. It names each recipient, so it is `operations:read`'s and nobody's own.
 */
export async function readUnattendedInbox(
  tx: TenantQuery,
  viewerPersonId: string,
): Promise<readonly UnattendedEntry[]> {
  return (await readUnattended(tx, viewerPersonId)).map((item) => ({
    id: item.id,
    recipientPersonId: item.recipientPersonId,
    subjectRecordId: item.subjectRecordId,
    reason: item.reason,
    factKind: item.factKind,
    factId: item.factId,
    raisedAt: item.raisedAt.toISOString(),
  }));
}
