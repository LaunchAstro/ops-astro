// SPDX-License-Identifier: AGPL-3.0-only
//
// C71 team chat, the web half: the Team panel's conversations from the two
// chat reads, sent through the chat commands, kept live on the tab's one
// stream (C4). Nothing here decides who may read what: both reads filter by
// membership on the server, and every refusal is the server's, said whole.
//
// `chat.conversations` lists the reader's conversations; `chat.messages` reads each one. The
// list is read again on every `board` signal (the server signals a conversation's members there
// when a message is written) and after each of the reader's own commands. A conversation's
// messages are read again when its own topic, `conversation:<uuid>`, signals, and whenever the
// list shows a newer message or a moved marker than the messages held.
//
// Every conversation held is followed (the panel keeps which is open to itself), the most
// recently active first, up to `FOLLOWED` of the tab's 32 topics; one past the cap still moves
// through the list. `closed` on a topic (the reader left, or was removed) re-reads the list,
// which shows a group left read-only; a change re-reads a group it shows departed as such.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectThread, GroupAction, GroupThread, TeamConversations } from '@launchastro/ui';
import type {
  ChatConversationView,
  ChatConversationsResult,
  ChatMessagesResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { BOARD } from '../../data/board-live.ts';
import { nudgeTeamUnread } from '../../data/dock-counts.ts';
import { hubOf } from '../../data/live.ts';
import { describeFailure } from '../../records/submit.ts';

const FOLLOWED = 16;

type ChatCommand =
  | 'chat.send_direct'
  | 'chat.send_group'
  | 'chat.mark_read'
  | 'chat.start_group'
  | 'chat.rename_group'
  | 'chat.change_members'
  | 'chat.leave';

/**
 * The reader's conversations: null until a read answers with them or a
 * refusal (an unavailable read keeps what was), `none` when chat is refused them.
 */
type Listed = readonly ChatConversationView[] | 'none' | null;

/** A conversation's messages, and whether they were asked while the list showed it departed. */
type Kept = ChatMessagesResult & { readonly departed: boolean };
/** Each conversation's messages; null when its read answered with none to draw. */
type Held = Readonly<Record<string, Kept | null>>;

export interface ChatModel {
  readonly list: Listed;
  readonly held: Held;
  /** The first list and each of its conversations' messages have answered; unavailable is not. */
  readonly settled: boolean;
  readonly run: (name: ChatCommand, body: Readonly<Record<string, unknown>>) => void;
}

interface Reads {
  readonly list: () => void;
  readonly messages: (conversationId: string, left: boolean) => void;
}

const timeOf = (iso: string | null | undefined): number | null =>
  iso === null || iso === undefined ? null : Date.parse(iso);

/** Whether the list says more than the messages held: a newer message or a moved marker. */
function stale(view: ChatConversationView, held: ChatMessagesResult | null | undefined): boolean {
  if (held === null || held === undefined) return true;
  const newest = held.messages.at(-1)?.at;
  return (
    timeOf(view.lastRead) !== timeOf(held.lastRead) || timeOf(view.lastMessageAt) !== timeOf(newest)
  );
}

/** The topics followed: the most recently active conversations, up to `FOLLOWED`. */
function topicsOf(list: Listed): string {
  if (list === null || list === 'none') return '';
  const recent = (view: ChatConversationView): number => timeOf(view.lastMessageAt) ?? 0;
  return list
    .toSorted((a, b) => recent(b) - recent(a))
    .slice(0, FOLLOWED)
    .map((view) => view.conversationId)
    .join(' ');
}

/** A reader who has left a group: the server withholds its name and members from them. */
const departed = (view: ChatConversationView): boolean => view.members.length === 0;
const leftIn = (list: Listed, id: string): boolean =>
  Array.isArray(list) && list.some((view) => view.conversationId === id && departed(view));

/** The list read, while `current`: only the newest lands, never undone by an older answer. */
function newestList(
  client: OperationsClient,
  setList: (update: (was: Listed) => Listed) => void,
  current: () => boolean,
): () => void {
  let lists = 0;
  return () => {
    lists += 1;
    const generation = lists;
    void client.read<ChatConversationsResult>('chat.conversations', {}).then((answer) => {
      if (!current() || lists !== generation) return answer;
      const listed = 'value' in answer ? answer.value.conversations : undefined;
      // A body with no list is read as no conversations, never drawn.
      if (Array.isArray(listed)) setList(() => listed);
      else setList((was) => (isUnavailable(answer) ? was : 'none'));
      return answer;
    });
  };
}

function useReads(
  client: OperationsClient,
  grantKey: string,
  setList: (update: (was: Listed) => Listed) => void,
  setHeld: (update: (was: Held) => Held) => void,
): Reads | null {
  const [reads, setReads] = useState<Reads | null>(null);
  useEffect(() => {
    let current = true;
    const asked = new Map<string, number>();
    const list = newestList(client, setList, () => current);
    const messages = (id: string, left: boolean): void => {
      const generation = (asked.get(id) ?? 0) + 1;
      asked.set(id, generation);
      void client
        .read<ChatMessagesResult>('chat.messages', { conversationId: id })
        .then((answer) => {
          if (!current || asked.get(id) !== generation) return answer;
          const read = 'value' in answer ? answer.value : undefined;
          // An unavailable read keeps what was held and answers for nothing.
          if (read === undefined && !isRefusal(answer)) return answer;
          const kept =
            read !== undefined && Array.isArray(read.messages) ? { ...read, departed: left } : null;
          setHeld((was) => ({ ...was, [id]: kept }));
          return answer;
        });
    };
    setReads({ list, messages });
    list();
    const stop = hubOf(client).follow(BOARD, list);
    return () => {
      current = false;
      stop();
      setReads(null);
      setList(() => null);
      setHeld(() => ({}));
    };
  }, [client, grantKey, setList, setHeld]);
  return reads;
}

/** Each followed conversation's topic: `closed` re-reads the list, a change its messages. */
function useTopics(client: OperationsClient, reads: Reads | null, list: Listed): void {
  const listRef = useRef(list);
  listRef.current = list;
  const topics = topicsOf(list);
  useEffect(() => {
    if (reads === null || topics === '') return;
    const hub = hubOf(client);
    const stops = topics.split(' ').map((id) =>
      hub.follow(`conversation:${id}`, (change) => {
        if (change === 'closed') reads.list();
        else reads.messages(id, leftIn(listRef.current, id));
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, reads, topics]);
}

/** Reads what the list shows newer, and a departed group's archive once the list shows it departed. */
function useMessageReads(reads: Reads | null, list: Listed, held: Held): void {
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (reads === null || list === null || list === 'none') return;
    for (const view of list) {
      const was = heldRef.current[view.conversationId];
      if (stale(view, was) || (departed(view) && was?.departed !== true))
        reads.messages(view.conversationId, departed(view));
    }
  }, [reads, list]);
}

/** The reader's conversations as the panel's host holds them; `say` hears a failed command's words. */
export function useChat(
  client: OperationsClient,
  grantKey: string,
  say: (because: string | null) => void,
): ChatModel {
  const [list, setList] = useState<Listed>(null);
  const [held, setHeld] = useState<Held>({});
  const reads = useReads(client, grantKey, setList, setHeld);
  useMessageReads(reads, list, held);
  useTopics(client, reads, list);

  const settledRef = useRef(false);
  if (list === null) settledRef.current = false;
  else if (list === 'none' || list.every((view) => view.conversationId in held)) {
    settledRef.current = true;
  }

  const run = useCallback(
    (name: ChatCommand, body: Readonly<Record<string, unknown>>): void => {
      say(null);
      void client.mutate(name, body).then((result) => {
        const failed = describeFailure(result);
        say(failed);
        if (failed === null) {
          reads?.list();
          nudgeTeamUnread(client);
        }
        return result;
      });
    },
    [client, reads, say],
  );

  return { list, held, settled: settledRef.current, run };
}

/** A group's action as its chat command; members sends only the side that names someone. */
function commandOf(action: GroupAction): readonly [ChatCommand, Record<string, unknown>] {
  switch (action.do) {
    case 'start':
      return ['chat.start_group', { name: action.name, members: action.members }];
    case 'rename':
      return ['chat.rename_group', { conversationId: action.id, name: action.name }];
    case 'members':
      return [
        'chat.change_members',
        {
          conversationId: action.id,
          ...(action.add.length > 0 ? { add: action.add } : {}),
          ...(action.remove.length > 0 ? { remove: action.remove } : {}),
        },
      ];
    case 'leave':
      return ['chat.leave', { conversationId: action.id }];
    case 'read':
      return ['chat.mark_read', { conversationId: action.id, upTo: action.upTo }];
    case 'send':
      return ['chat.send_group', { conversationId: action.id, body: action.body }];
  }
}

/**
 * What the panel draws for reader `me`: each conversation whose messages are
 * held, a direct one named by its other member. `canManage` is false: the
 * list does not say who started a group, so rename and membership are not
 * offered here, and the server answers either way.
 */
export function talkOf(chat: ChatModel, me: string): TeamConversations | null {
  const { list } = chat;
  if (list === null || list === 'none') return null;
  const threads: DirectThread[] = [];
  const groups: GroupThread[] = [];
  for (const view of list) {
    const held = chat.held[view.conversationId];
    if (held === null || held === undefined) continue;
    // Nothing from before the reader's current join (a rejoin is a new window), as the
    // server serves. A departed view draws a read asked since the list showed it departed,
    // while that read agrees with it, all read: no marker is kept there to clear its unread.
    const since = timeOf(view.joinedAt) ?? -Infinity;
    const left = departed(view);
    const archive = held.departed && !stale(view, held) ? held.messages : [];
    const messages = left ? archive : held.messages.filter((m) => Date.parse(m.at) >= since);
    const readable = { lastRead: left ? (messages.at(-1)?.at ?? null) : held.lastRead, messages };
    const other = view.members.find((id) => id !== me);
    if (view.kind === 'direct' && other !== undefined) threads.push({ with: other, ...readable });
    else if (view.kind === 'group') {
      const { conversationId: id, members } = view;
      const name = view.name ?? 'A group you left';
      groups.push({ id, name, members, canManage: false, left, ...readable });
    }
  }
  const directWith = (person: string): string | undefined =>
    list.find((view) => view.kind === 'direct' && view.members.includes(person))?.conversationId;
  return {
    threads,
    groups,
    onMarkRead: (person, upTo) => {
      const conversationId = directWith(person);
      if (conversationId !== undefined) chat.run('chat.mark_read', { conversationId, upTo });
    },
    onSend: (person, body) => {
      chat.run('chat.send_direct', { teammateId: person, body });
    },
    onGroup: (action) => {
      chat.run(...commandOf(action));
    },
  };
}
