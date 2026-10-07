// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C71 team chat, the web half (CS-7.25, CS-7.26, CS-7.41, CS-7.42): the Team
// screen feeds the kit's TeamPanel from the two chat reads and sends through
// the chat commands, with no Mock label on those real paths. A conversation's
// own topic, `conversation:<uuid>`, re-reads its messages; the board topic
// re-reads the reader's conversations, and with them the Team tab's unread
// chip. A refused send shows the API's own refusal. The server is a stand-in
// whose stream the case writes into; the server half (the topic, its member
// check, the board's conversation signal) is proven in tests/api.

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTeamUnread } from '../../apps/web/src/data/dock-counts.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from './mount.tsx';

const DIRECT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Message {
  id: string;
  authorId: string;
  author: string;
  at: string;
  body: string;
}

const said = (id: string, authorId: string, at: string): Message => ({
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

interface World {
  readonly chats: Chats;
  readonly state: { refuse: Record<string, unknown> | null };
  readonly reads: string[];
  readonly sent: { at: string; body: Record<string, unknown> }[];
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
  return json({ recordId: DIRECT, revision: 1, detail: { conversationId: DIRECT } });
}

/** One business: me, Bo and Cy, and a live channel whose latest stream the case writes into. */
function server() {
  const world: World = { chats: chatsOf(), state: { refuse: null }, reads: [], sent: [] };
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

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await settle();
  await until(say, check, deadline);
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const shown = (m: Mounted): string[] =>
  m.all('.tmc__conv .msg').map((el) => (el as HTMLElement).dataset['message'] ?? '');

async function team() {
  const api = server();
  view = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  const m = view;
  await until('the conversation open on Bo', () => shown(m).length > 0);
  return { api, m };
}

async function sendWords(m: Mounted, words: string): Promise<void> {
  await m.type('.tmc__conv .composer input', words);
  await act(() => {
    m.host
      .querySelector('.tmc__conv form.composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** A command as sent, its fresh operation id checked and set aside. */
const strip = ({ at, body }: { at: string; body: Record<string, unknown> }) => {
  const { operationId, ...rest } = body;
  expect(typeof operationId).toBe('string');
  return { at, ...rest };
};

describe('C71 web (1) the Team panel shows the real conversations, with no mock label', () => {
  it('feeds TeamPanel from chat.conversations and chat.messages and opens on the first unread', async () => {
    const { api, m } = await team();
    expect(shown(m)).toEqual(['m1', 'm2']);
    expect(m.find('[data-person="p-bo"] .cbadge')?.textContent).toBe('1');
    expect(m.find(`[data-group="${GROUP}"]`)?.textContent).toBe('Shoot crew');
    expect(api.reads).toContain('conversations');
    expect(api.reads).toContain(`messages ${DIRECT}`);
    expect(api.reads).toContain(`messages ${GROUP}`);
    expect(m.find('[data-provenance="mock"]')).toBeNull();
    expect(m.find('.mocktag')).toBeNull();
  });

  it('sends and reads through chat.send_direct, chat.mark_read and chat.send_group', async () => {
    const { api, m } = await team();
    await m.click('.tmc__conv .tmc__scroll');
    await sendWords(m, 'On my way');
    await m.click(`[data-group="${GROUP}"]`);
    await sendWords(m, 'Shoot at 2');
    await until('four commands', () => api.sent.length === 4);
    expect(api.sent.map(strip)).toEqual([
      { at: '/chat/mark_read', conversationId: DIRECT, upTo: '2026-10-01T10:00:00.000Z' },
      { at: '/chat/send_direct', teammateId: 'p-bo', body: 'On my way' },
      { at: '/chat/mark_read', conversationId: GROUP, upTo: '2026-10-01T07:00:00.000Z' },
      { at: '/chat/send_group', conversationId: GROUP, body: 'Shoot at 2' },
    ]);
  });
});

describe('C71 web (2) the open thread moves on its own topic', () => {
  it('re-reads chat.messages when the stream signals conversation:<uuid>', async () => {
    const { api, m } = await team();
    await until('the conversation topic joined', () =>
      (api.joins.at(-1) ?? '').includes(`topic=conversation%3A${DIRECT}`),
    );
    await settle();
    const before = api.reads.length;
    api.chats[DIRECT]?.messages.push(said('m3', 'p-bo', '2026-10-01T11:00:00.000Z'));
    api.send('invalidate', `conversation:${DIRECT}`);
    await until('the new message drawn', () => shown(m).includes('m3'));
    expect(api.reads.slice(before)).toEqual([`messages ${DIRECT}`]);
  });
});

describe("C71 web (3) the Team tab's unread chip moves on the board stream", () => {
  it('paints at load from chat.conversations and re-reads it when the board topic signals', async () => {
    const api = server();
    const session: Session = { businessKey: 'alpha', email: 'ana@example.test' };
    function Chip(): ReactElement {
      const unread = useTeamUnread(api.client, session, true);
      return <b data-chip>{unread === null ? 'none' : String(unread)}</b>;
    }
    view = await mount(<Chip />);
    const m = view;
    const chip = (): string | undefined => m.find('[data-chip]')?.textContent ?? undefined;
    await until('the chip painted', () => chip() === '2');
    await until('the board joined', () => (api.joins.at(-1) ?? '').includes('topic=board'));
    const chat = api.chats[DIRECT];
    if (chat !== undefined) chat.view = { ...chat.view, unread: 4 };
    api.send('resync', 'board');
    await until('the chip moved', () => chip() === '5');
    expect(api.reads.filter((read) => read === 'conversations')).toHaveLength(2);
  });
});

describe('C71 web (4) a refused send shows the API’s own refusal', () => {
  it('draws the refusal text the API answered', async () => {
    const { api, m } = await team();
    api.state.refuse = {
      refused: true,
      code: 'FIELD_VALUE_INVALID',
      names: ['body'],
      fixes: ['Write the message before sending it.'],
    };
    await sendWords(m, 'x');
    await until('the refusal drawn', () => m.find('[role="alert"]') !== null);
    expect(m.find('[role="alert"]')?.textContent).toBe(
      'FIELD_VALUE_INVALID (body). Write the message before sending it.',
    );
  });
});
