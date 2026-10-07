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
// task or the fact it points at. A mention in a team conversation (C71) is
// about the conversation, held by its current members alone, and is named by
// it: its kind and a group's name, never a task.

import {
  askedFor,
  clientsReached,
  countOwedItems,
  readInboxItems,
  readUnattended,
  type InboxItem,
  type Subject,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type {
  InboxConversation,
  InboxEntry,
  PersonView,
  UnattendedView,
} from '../../../core-wire/src/index.ts';

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
 * A readable entry is named: its task's key and title, read in the statement
 * that found the task readable (`readInboxItems`), who closed it, and its
 * task's client where the caller's subjects reach that client (MP-7-3). The
 * item stores none of them, so a rename reads renamed.
 */
export async function readInbox(
  tx: TenantQuery,
  personId: string,
  subjects: readonly Subject[],
): Promise<readonly InboxEntry[]> {
  const items = await readInboxItems(tx, personId, chats(subjects));
  return await named(
    tx,
    items.filter((item) => item.access !== 'withheld'),
    subjects,
  );
}

/** The owed count: the list's counted entries, counted in one query under the same rule. */
export async function countOwed(
  tx: TenantQuery,
  personId: string,
  subjects: readonly Subject[],
): Promise<number> {
  return await countOwedItems(tx, personId, chats(subjects));
}

/** Whether conversations are shown at all: to an agent key (API-2) only when it ticks `chat:comment`. */
const chats = (subjects: readonly Subject[]): boolean =>
  askedFor(subjects, { collection: 'chat', action: 'comment' }).length > 0;

/**
 * Which of these clients the subjects reach, by C32's own rule: a grant over
 * the business, or on the client. Asked only of the listed tasks' clients.
 */
async function reachedClients(
  tx: TenantQuery,
  subjects: readonly Subject[],
  clientIds: readonly string[],
): Promise<ReadonlyMap<string, { readonly clientId: string; readonly name: string }>> {
  if (clientIds.length === 0) return new Map();
  const reached = (await clientsReached(tx, subjects, clientIds)) ?? [];
  return new Map(reached.map((row) => [row.clientId, row]));
}

async function named(
  tx: TenantQuery,
  items: readonly InboxItem[],
  subjects: readonly Subject[],
): Promise<readonly InboxEntry[]> {
  const readable = items.flatMap((item) => (item.access === 'readable' ? [item] : []));
  if (readable.length === 0) return items.map((item) => entryOf(item));
  const deciderIds = [...new Set(readable.flatMap((item) => item.closedByPersonId ?? []))];
  const clientIds = [...new Set(readable.flatMap((item) => item.clientId ?? []))];
  const reached = await reachedClients(tx, subjects, clientIds);
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
  return items.map((item) => {
    if (item.access !== 'readable') return entryOf(item);
    const client = reached.get(item.clientId ?? '');
    const decider = item.closedByPersonId;
    const naming = item.conversation
      ? { conversation: conversationOf(item.subjectRecordId, item.task) }
      : { task: item.task };
    return {
      ...entryOf(item),
      ...naming,
      ...(client === undefined ? {} : { client }),
      closedBy: decider === null ? null : (people.get(decider) ?? null),
    };
  });
}

function conversationOf(
  conversationId: string,
  subject: { readonly key: string; readonly title: string | null },
): InboxConversation {
  return {
    conversationId,
    kind: subject.key === 'group' ? 'group' : 'direct',
    name: subject.title,
  };
}

/**
 * The business's unattended items whose task the caller can read: the list
 * the operations view (C55) shows, and `inbox.unattended` on the API and the
 * command line. It names each recipient, so it is `operations:read`'s and nobody's own.
 */
export async function readUnattendedInbox(
  tx: TenantQuery,
  viewerPersonId: string,
): Promise<readonly UnattendedView[]> {
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
