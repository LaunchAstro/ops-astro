// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox read and the owed count (INB-1d). One permission-checked read: the
// caller's own items, each with its access derived now from their live grants
// (`readInboxItems`), and the count is that same read's counted entries, so the
// two cannot disagree and neither waits on the worker.
//
// Counted means open, owed and readable. Read is not done (reading changes
// nothing), delivered is not seen (the last attempt and the attention row are
// separate fields), and withheld is not gone. A withheld item, about a task the
// caller holds no read on, is not listed at all: its identity, reason and times
// would say that another client's task exists. It stays stored and comes back
// at the first read after access returns. A gone item, a trashed task the
// caller still holds read on, is listed as gone and names nothing of the task
// or the fact it points at.

import { readInboxItems, type InboxItem } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

export interface InboxEntry {
  readonly id: string;
  readonly reason: InboxItem['reason'];
  readonly workState: InboxItem['workState'];
  readonly access: Exclude<InboxItem['access'], 'withheld'>;
  readonly owed: boolean;
  /** Open, owed and readable now: exactly what the count counts. */
  readonly counted: boolean;
  readonly raisedAt: string;
  readonly closedAt: string | null;
  readonly seenAt: string | null;
  readonly lastDelivery: InboxItem['lastDelivery'];
  /** The pointer, present only while the caller can read the task. */
  readonly subjectRecordId?: string;
  readonly factKind?: InboxItem['factKind'];
  readonly factId?: string;
  readonly closedByPersonId?: string | null;
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

function entryOf(item: InboxItem & { readonly access: InboxEntry['access'] }): InboxEntry {
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
        }
      : {}),
  };
}

const isListed = (item: InboxItem): item is InboxItem & { readonly access: InboxEntry['access'] } =>
  item.access !== 'withheld';

/** The caller's own inbox, newest raised last, as `readInboxItems` orders it. */
export async function readInbox(tx: TenantQuery, personId: string): Promise<readonly InboxEntry[]> {
  return (await readInboxItems(tx, personId)).filter(isListed).map(entryOf);
}

/** The owed count: the counted entries of the same read, never a second query. */
export async function countOwed(tx: TenantQuery, personId: string): Promise<number> {
  return (await readInbox(tx, personId)).filter((entry) => entry.counted).length;
}
