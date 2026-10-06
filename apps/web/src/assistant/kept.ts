// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 CS-7.33, C36: the drawer's history and the tabs it keeps.
//
// **Kept for the session, as ids only.** Each started tab's conversation id is
// kept in the tab's `sessionStorage` (the rule the session lives under), under
// the session's own grant key, so a reload brings the tabs back and another
// person's sign-in reads its own key, not these. No title or words are kept: a
// copy left in the tab after sign-out is opaque ids, readable back only by
// their owner or a holder of the read-any grant (`conversation.read`'s own
// rule), who may read that conversation anyway. A tab not yet started holds
// nothing the server has and is not kept. What comes back from storage is read
// through a closed shape (the exact keys, a bounded list, ids in the uuid form)
// and anything else brings back nothing.
//
// **Read again when they come back.** A kept tab's transcript is never stored:
// it is `conversation.read`'s, read as the drawer opens, so a reply that landed
// after its response was lost is there, with its title. A question asked in a
// kept tab waits for that read, so the transcript never lands over it. A
// conversation reopened from the history list is read the same way. Reading
// writes nothing.

import { useEffect, useRef, useState } from 'react';
import type { AssistantHistory, AssistantMessage, AssistantPast } from '@launchastro/ui';
import type {
  ConversationListResult,
  ConversationReadResult,
} from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import { jsonSlot, tabStorage, type JsonSlot } from '../session/storage-slot.ts';
import {
  initial,
  reopened,
  select,
  transcript,
  type AssistantState,
  type Reopened,
} from './chats.ts';
import { useStore, type Store } from './store.ts';

interface Kept {
  readonly selected: string | null;
  readonly tabs: readonly string[];
}

/** At most this many started tabs come back. */
export const KEPT_LIMIT = 8;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

const exactly = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isKept(value: unknown): value is Kept {
  if (typeof value !== 'object' || value === null || !exactly(value, ['selected', 'tabs'])) {
    return false;
  }
  const { selected, tabs } = value as Record<string, unknown>;
  return (
    (selected === null || isId(selected)) &&
    Array.isArray(tabs) &&
    tabs.length <= KEPT_LIMIT &&
    tabs.every((tab) => isId(tab))
  );
}

const slotFor = (grantKey: string): JsonSlot<Kept> =>
  jsonSlot(tabStorage(), `ops-astro:drawer-tabs:${grantKey}`, isKept);

/** The drawer's first state: the session's kept tabs, unread, or one fresh tab. */
function keptState(grantKey: string | undefined): AssistantState {
  const kept = grantKey === undefined ? null : slotFor(grantKey).read();
  if (kept === null || kept.tabs.length === 0) return initial();
  const empty: AssistantState = { ...initial(), chats: [], selected: '', next: 1 };
  const tabs = reopened(
    empty,
    kept.tabs.map((conversationId) => ({ conversationId, title: READING, messages: [] })),
  );
  const chosen = tabs.chats.find((chat) => chat.conversationId === kept.selected);
  return chosen === undefined ? tabs : select(tabs, chosen.key);
}

function keptOf(state: AssistantState): Kept {
  const started = state.chats.filter((chat) => chat.conversationId !== null).slice(-KEPT_LIMIT);
  const selected = state.chats.find((chat) => chat.key === state.selected)?.conversationId ?? null;
  return {
    selected: started.some((chat) => chat.conversationId === selected) ? selected : null,
    tabs: started.map((chat) => chat.conversationId ?? ''),
  };
}

/** A kept tab's title until its read lands. */
const READING = 'Reading…';

const PURGED = 'This conversation’s messages have been cleared; its wrap-up is at its address.';

/** `conversation.read`'s transcript as the drawer's lines, or a note once the body has purged. */
function linesOf(read: ConversationReadResult): AssistantMessage[] {
  if (read.messages === null) return [{ id: 'purged', role: 'note', body: PURGED, cites: [] }];
  return read.messages.map((one) => ({
    id: `kept-${one.id}`,
    role: one.role === 'person' ? 'user' : 'ai',
    body: one.body,
    cites: [],
  }));
}

/** One conversation read for a tab, or the server's reason it cannot be. */
async function readOne(
  client: OperationsClient,
  conversationId: string,
): Promise<Reopened | string> {
  const answer = await client.read<ConversationReadResult>('conversation.read', {
    conversationId,
  });
  if (isUnavailable(answer)) return answer.because;
  if (isRefusal(answer)) return answer.fixes[0] ?? answer.code;
  const { conversation } = answer.value;
  return { conversationId, title: conversation.title, messages: linesOf(answer.value) };
}

/** The drawer's store, and each kept tab's read: a question asked there waits for it. */
export type KeptStore = Store & { readonly settled: (key: string) => Promise<void> };

/** The drawer's store from the session's kept tabs, read again on open, every change kept. */
export function useKeptStore(client: OperationsClient, grantKey: string | undefined): KeptStore {
  const store = useStore(() => keptState(grantKey));
  const reads = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    for (const chat of store.now().chats) {
      const id = chat.conversationId;
      if (id === null || chat.messages.length > 0) continue;
      const landed = (async () => {
        const read = await readOne(client, id);
        const failed = { id: `kept-failed-${id}`, role: 'failed' as const, body: '', cites: [] };
        const into = typeof read === 'string' ? { messages: [{ ...failed, body: read }] } : read;
        store.update((current) => transcript(current, id, into));
      })();
      reads.current.set(chat.key, landed);
    }
    // Once, as the drawer opens: later tabs are read as they are reopened.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (grantKey !== undefined) slotFor(grantKey).write(keptOf(store.state));
  }, [grantKey, store.state]);
  return { ...store, settled: async (key) => await reads.current.get(key) };
}

/** The history list: read when shown; a row reopens its conversation as a tab. */
export function useHistoryList(client: OperationsClient, store: Store): AssistantHistory {
  const [past, setPast] = useState<readonly AssistantPast[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const onShow = (): void => {
    setPast(null);
    setSaid(null);
    void (async () => {
      const answer = await client.read<ConversationListResult>('conversation.list', {});
      if (isUnavailable(answer)) setSaid(answer.because);
      else if (isRefusal(answer)) setSaid(answer.fixes[0] ?? answer.code);
      else setPast(answer.value.conversations);
    })();
  };
  const onOpen = (id: string): void => {
    const open = store.now().chats.find((chat) => chat.conversationId === id);
    if (open !== undefined) {
      store.update((current) => select(current, open.key));
      return;
    }
    void (async () => {
      const read = await readOne(client, id);
      if (typeof read === 'string') setSaid(read);
      else store.update((current) => reopened(current, [read]));
    })();
  };
  return { past, said, onShow, onOpen };
}
