// SPDX-License-Identifier: AGPL-3.0-only
//
// The C71 web suites' stand-in server: the chat reads and commands answered
// from a world the case can change, and a live channel whose latest stream the
// case writes into. Split from `c71-c-team-chat-web.test.tsx` so it stays under
// the per-file cap.

import { OperationsClient } from '../../apps/web/src/operations/client.ts';

export const DIRECT = '11111111-1111-4111-8111-111111111111';
export const GROUP = '22222222-2222-4222-8222-222222222222';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface Message {
  id: string;
  authorId: string;
  author: string;
  at: string;
  body: string;
}

export const said = (id: string, authorId: string, at: string): Message => ({
  id,
  authorId,
  author: authorId === 'p-bo' ? 'Bo Reyes' : 'Cy Tran',
  at,
  body: `words ${id}`,
});

type Chats = Record<string, { view: Record<string, unknown>; messages: Message[] }>;

/** A direct conversation with Bo, one unread, and the group "Shoot crew", one unread. */
const chatsOf = (): Chats => ({
  [DIRECT]: {
    view: {
      conversationId: DIRECT,
      kind: 'direct',
      name: null,
      members: ['p-me', 'p-bo'],
      lastRead: '2026-10-01T09:00:00.000Z',
      lastMessageAt: '2026-10-01T10:00:00.000Z',
      unread: 1,
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
      lastRead: null,
      lastMessageAt: '2026-10-01T07:00:00.000Z',
      unread: 1,
    },
    messages: [said('g1', 'p-cy', '2026-10-01T07:00:00.000Z')],
  },
});

const PEOPLE = [
  { personId: 'p-me', name: 'Ana Bell', availability: null },
  { personId: 'p-bo', name: 'Bo Reyes', availability: null },
  { personId: 'p-cy', name: 'Cy Tran', availability: null },
];

/** How a send goes wrong: refused, unanswered before it lands, or landed with its answer lost. */
interface Sending {
  refuse: Record<string, unknown> | null;
  unanswered: 'before' | 'after' | null;
}

interface World {
  readonly chats: Chats;
  readonly state: Sending;
  readonly reads: string[];
  readonly sent: { at: string; body: Record<string, unknown> }[];
  /** Each message a send landed, once per operation id, as the operations register keeps it. */
  readonly posted: Map<string, string>;
}

/** The reads and commands, answered from `world`. */
function answer(world: World, at: string, body: Record<string, unknown>): Response {
  if (at.endsWith('/team/list')) return json({ ok: true, you: 'p-me', people: PEOPLE });
  if (at.endsWith('/chat/conversations')) {
    world.reads.push('conversations');
    const conversations = Object.values(world.chats).map((chat) => chat.view);
    return json({ ok: true, conversations });
  }
  if (at.endsWith('/chat/messages')) {
    const id = String(body['conversationId']);
    world.reads.push(`messages ${id}`);
    const chat = world.chats[id];
    if (chat === undefined)
      return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    const { lastRead } = chat.view;
    return json({ ok: true, conversationId: id, lastRead, messages: chat.messages });
  }
  if (!at.includes('/chat/')) throw new Error(`unrouted ${at}`);
  world.sent.push({ at: at.slice(at.indexOf('/chat/')), body });
  if (world.state.refuse !== null) return json(world.state.refuse, 422);
  if (world.state.unanswered === 'before') return json({}, 503);
  const sends = at.endsWith('/chat/send_direct') || at.endsWith('/chat/send_group');
  if (sends) world.posted.set(String(body['operationId']), String(body['body']));
  if (world.state.unanswered === 'after') return json({}, 503);
  return json({ recordId: DIRECT, revision: 1, detail: { conversationId: DIRECT } });
}

/** One business: me, Bo and Cy, and a live channel whose latest stream the case writes into. */
export function server() {
  const world: World = {
    chats: chatsOf(),
    state: { refuse: null, unanswered: null },
    reads: [],
    sent: [],
    posted: new Map(),
  };
  const joins: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.includes('/live')) {
      joins.push(at);
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
    return answer(world, at, JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    ...world,
    client,
    joins,
    send: (event: string, topic: string) =>
      stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${topic}\n\n`)),
  };
}
