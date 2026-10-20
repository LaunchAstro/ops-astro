// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in server for the Team chat's web writes, whose answers the case
// holds and lets go in the order it chooses: a command's answer held, lost or
// refused; a chat.conversations answer held with the world as it stood when
// it was asked. `chat.mark_read` moves the reader's marker as the server does.
// The group is one the reader manages, so Rename and Remove are offered.

import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { DIRECT, GROUP, said, type Message } from './team-chat-stand-in.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PEOPLE = [
  { personId: 'p-me', name: 'Ana Bell', availability: null },
  { personId: 'p-bo', name: 'Bo Reyes', availability: null },
  { personId: 'p-cy', name: 'Cy Tran', availability: null },
];

type View = Record<string, unknown>;

const chatsOf = (): Record<string, { view: View; messages: Message[] }> => ({
  [DIRECT]: {
    view: {
      conversationId: DIRECT,
      kind: 'direct',
      name: null,
      members: ['p-me', 'p-bo'],
      joinedAt: null,
      lastRead: '2026-10-01T09:00:00.000Z',
      lastMessageAt: '2026-10-01T10:00:00.000Z',
      unread: 1,
      canManage: false,
    },
    messages: [
      said('m1', 'p-bo', '2026-10-01T08:00:00.000Z'),
      said('m2', 'p-bo', '2026-10-01T10:00:00.000Z'),
    ],
  },
  [GROUP]: {
    view: {
      conversationId: GROUP,
      kind: 'group',
      name: 'Shoot crew',
      members: ['p-me', 'p-bo', 'p-cy'],
      joinedAt: null,
      lastRead: '2026-10-01T07:00:00.000Z',
      lastMessageAt: '2026-10-01T07:00:00.000Z',
      unread: 0,
      canManage: true,
    },
    messages: [said('g1', 'p-cy', '2026-10-01T07:00:00.000Z')],
  },
});

const REFUSED = { refused: true, code: 'NOT_FOUND', names: [], fixes: ['Read the group again.'] };

/** One business's chat, its answers held at the case's word. */
// eslint-disable-next-line max-lines-per-function -- one stand-in, the answers it holds
export function heldServer(businessKey = 'alpha') {
  const chats = chatsOf();
  const sent: { at: string; body: Record<string, unknown> }[] = [];
  const held: (() => void)[] = [];
  const settings = {
    holdCommands: false,
    holdLists: false,
    reply: 'answer' as 'answer' | 'lose' | 'refuse',
  };
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const waitTurn = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      held.push(resolve);
    });
  };
  const command = async (at: string, body: Record<string, unknown>): Promise<Response> => {
    sent.push({ at, body });
    const reply = settings.reply;
    if (at === '/chat/mark_read') {
      const chat = chats[String(body['conversationId'])];
      if (chat !== undefined) chat.view = { ...chat.view, lastRead: body['upTo'], unread: 0 };
    }
    if (settings.holdCommands) await waitTurn();
    if (reply === 'lose') throw new TypeError('the answer was lost');
    if (reply === 'refuse') return json(REFUSED, 404);
    return json({ recordId: GROUP, revision: 1, detail: { conversationId: GROUP } });
  };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.includes('/live')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/team/list')) return json({ ok: true, you: 'p-me', people: PEOPLE });
    if (at.endsWith('/chat/conversations')) {
      const conversations = structuredClone(Object.values(chats).map((chat) => chat.view));
      if (settings.holdLists) await waitTurn();
      return json({ ok: true, conversations });
    }
    if (at.endsWith('/chat/messages')) {
      const chat = chats[String(body['conversationId'])];
      if (chat === undefined) return json(REFUSED, 404);
      const { conversationId, lastRead } = chat.view;
      return json({ ok: true, conversationId, lastRead, messages: [...chat.messages] });
    }
    return await command(at.slice(at.indexOf('/chat/')), body);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  return {
    chats,
    sent,
    settings,
    client,
    /** Lets the oldest held answer go, or the one at `index`. */
    letGo: (index = 0) => held.splice(index, 1)[0]?.(),
    heldCount: () => held.length,
    signal: (event: string, topic: string) =>
      stream?.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${topic}\n\n`)),
  };
}
