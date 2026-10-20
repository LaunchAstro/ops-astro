// SPDX-License-Identifier: AGPL-3.0-only
//
// The Notifications panel's model over INB-1's inbox read (MP-7-3).
//
// The panel is a face on one list, not a second queue: it filters, groups and
// orders what `inbox.read` returned and counts nothing the owed count decides.
// `InboxItem` is the part of INB-1's inbox entry the panel draws, restated here
// because this package imports no `core-*` package; the application passes the
// entries through unchanged.

export interface InboxItem {
  readonly id: string;
  readonly reason:
    | 'decision'
    | 'waiting_run'
    | 'run_finished'
    | 'assignment'
    | 'mention'
    | 'incident'
    | 'client_comment';
  readonly workState: 'open' | 'cleared' | 'withdrawn';
  /** Derived by INB-1 at every read: only `readable` items name their task. */
  readonly access: 'readable' | 'withheld' | 'gone';
  readonly owed: boolean;
  readonly counted: boolean;
  readonly raisedAt: string;
  readonly closedAt: string | null;
  readonly task?: InboxTask | undefined;
  /** The team conversation a chat mention is about (C71); such an entry names no task. */
  readonly conversation?: InboxConversation | undefined;
}

export interface InboxTask {
  readonly key: string;
  readonly title: string | null;
}

/** A team conversation: a group's name, null on a direct one. */
export interface InboxConversation {
  readonly conversationId: string;
  readonly kind: 'direct' | 'group';
  readonly name: string | null;
}

/** The group an item is drawn under: its client, or the business's own work. */
export interface InboxGroupRef {
  readonly key: string;
  readonly name: string;
  /** Where the client opens; absent for a group that is not a client. */
  readonly href?: string | undefined;
}

export type InboxTab = 'owed' | 'info';
/** Owed and open, open and not owed, or closed and kept for the record. */
export type InboxBand = 'owe' | 'fyi' | 'done';

/** An item drawn as a row: it opens its task, or, for a chat mention, its conversation. */
export type DrawnItem =
  | (InboxItem & { readonly task: InboxTask })
  | (InboxItem & { readonly task?: undefined; readonly conversation: InboxConversation });

export interface InboxGroup {
  readonly ref: InboxGroupRef;
  /** Newest activity first. */
  readonly items: readonly DrawnItem[];
  /** Open items owed a response, the figure on the group head. */
  readonly owe: number;
  readonly last: number;
}

export function bandOf(item: InboxItem): InboxBand {
  if (item.workState !== 'open') return 'done';
  return item.owed ? 'owe' : 'fyi';
}

/** An owed item, open or closed, sits in the owed tab, so every item has exactly one place. */
export function tabOf(item: InboxItem): InboxTab {
  return item.owed ? 'owed' : 'info';
}

/**
 * Only an item the reader can still read is drawn, and only with somewhere to
 * open. A withheld or gone item names neither a task nor a conversation, and
 * one that somehow carried one anyway is still not drawn.
 */
export function drawable(item: InboxItem): item is DrawnItem {
  return item.access === 'readable' && (item.task !== undefined || item.conversation !== undefined);
}

/** What a drawn row opens and what it says: its task, or a chat mention's conversation. */
export function doorOf(item: DrawnItem): {
  readonly to: 'task' | 'conversation';
  readonly key: string;
  readonly text: string;
} {
  if (item.task !== undefined)
    return { to: 'task', key: item.task.key, text: item.task.title ?? item.task.key };
  const { conversationId, name } = item.conversation;
  return { to: 'conversation', key: conversationId, text: name ?? 'A direct message' };
}

const activity = (item: InboxItem): number => Date.parse(item.closedAt ?? item.raisedAt) || 0;

/** The tab's items by group: most owed first, then the most recent activity. */
export function groupsOf(
  items: readonly InboxItem[],
  tab: InboxTab | undefined,
  groupOf: (item: InboxItem) => InboxGroupRef,
): readonly InboxGroup[] {
  const groups = new Map<string, { ref: InboxGroupRef; items: DrawnItem[] }>();
  for (const item of items) {
    if (!drawable(item) || (tab !== undefined && tabOf(item) !== tab)) continue;
    const ref = groupOf(item);
    const group = groups.get(ref.key) ?? { ref, items: [] };
    group.items.push(item);
    groups.set(ref.key, group);
  }
  return [...groups.values()]
    .map(({ ref, items: held }) => {
      const sorted = held.toSorted((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));
      return {
        ref,
        items: sorted,
        owe: sorted.filter((item) => bandOf(item) === 'owe').length,
        last: sorted.length === 0 ? 0 : activity(sorted[0] as DrawnItem),
      };
    })
    .toSorted((a, b) => b.owe - a.owe || b.last - a.last || a.ref.name.localeCompare(b.ref.name));
}

/** Band heads are drawn only when the groups shown hold two live bands between them. */
export function bandHeads(groups: readonly InboxGroup[]): boolean {
  const live = new Set<InboxBand>();
  for (const group of groups) {
    for (const item of group.items) if (bandOf(item) !== 'done') live.add(bandOf(item));
  }
  return live.size > 1;
}

/** Open items in a tab: the not-owed tab's figure. The owed figure is `inbox.count`'s. */
export function liveCount(groups: readonly InboxGroup[]): number {
  return groups.reduce(
    (total, group) => total + group.items.filter((item) => bandOf(item) !== 'done').length,
    0,
  );
}
