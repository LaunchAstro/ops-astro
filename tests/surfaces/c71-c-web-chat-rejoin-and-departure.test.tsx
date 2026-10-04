// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { mount, settle } from './mount.tsx';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-01T10:00:00.000Z';
const REJOINED = '2026-10-01T11:00:00.000Z';
const message = {
  id: 'm1',
  authorId: 'p-bo',
  author: 'Bo Reyes',
  at: AT,
  body: 'old-window canary',
};
const conversation = {
  conversationId: ID,
  kind: 'group',
  name: 'Shoot crew',
  members: ['p-me', 'p-bo', 'p-cy'],
  joinedAt: '2026-10-01T09:00:00.000Z',
  lastRead: null,
  lastMessageAt: AT,
  unread: 1,
};

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each answer lands before its next effect
    await settle();
  }
}

interface ServerState {
  window: string;
  failMessages: boolean;
  messageReads: number;
  /** While set, a messages read answers only once it is released. */
  held: (() => void)[] | null;
}

function teamList(): Response {
  return Response.json({
    ok: true,
    you: 'p-me',
    people: [
      { personId: 'p-me', name: 'Ana Bell', availability: null },
      { personId: 'p-bo', name: 'Bo Reyes', availability: null },
      { personId: 'p-cy', name: 'Cy Tran', availability: null },
    ],
  });
}

function conversations(state: ServerState): Response {
  // These are the server's actual membership-window shapes: leaving
  // withholds name and members, rejoining discards the earlier history.
  const view =
    state.window === 'left'
      ? { ...conversation, name: null, members: [], joinedAt: null }
      : state.window === 'rejoined'
        ? { ...conversation, joinedAt: REJOINED, lastMessageAt: null, unread: 0 }
        : conversation;
  return Response.json({ ok: true, conversations: [view] });
}

async function messages(state: ServerState): Promise<Response> {
  state.messageReads += 1;
  if (state.failMessages) return Response.json({ error: 'temporarily down' }, { status: 503 });
  const answer = Response.json({
    ok: true,
    conversationId: ID,
    lastRead: null,
    messages: state.window === 'rejoined' ? [] : [message],
  });
  const { held } = state;
  if (held !== null) {
    await new Promise<void>((release) => {
      held.push(release);
    });
  }
  return answer;
}

function server() {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const state: ServerState = {
    window: 'first',
    failMessages: false,
    messageReads: 0,
    held: null,
  };
  const answer = async (at: string): Promise<Response> => {
    if (at.includes('/live?')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (at.endsWith('/team/list')) return teamList();
    if (at.endsWith('/chat/conversations')) return conversations(state);
    if (at.endsWith('/chat/messages')) return await messages(state);
    throw new Error(`unexpected ${at}`);
  };
  const fetch: typeof globalThis.fetch = async (input) =>
    await Promise.resolve().then(async () => await answer(String(input)));
  return {
    state,
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    signal(event: string, topic: string): void {
      if (stream === undefined) throw new Error('no stream');
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${topic}\n\n`));
    },
  };
}

it('recovery from an unavailable first message read opens the first unread conversation', async () => {
  const api = server();
  api.state.failMessages = true;
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  await flush();
  expect(api.state.messageReads).toBeGreaterThan(0);
  expect(page.find('.tmc__conv [data-message="m1"]')).toBeNull();
  api.state.failMessages = false;
  await act(() => {
    api.signal('invalidate', `conversation:${ID}`);
  });
  await flush();
  expect(page.find('.tmc__glist .cbadge')?.textContent).toBe('1');
  expect(page.find('.tmc__conv [data-message="m1"]')).not.toBeNull();
});

it('a group rejoin cannot redraw messages from the earlier membership window', async () => {
  const api = server();
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  await flush();
  expect(page.text()).toContain('old-window canary');
  api.state.window = 'left';
  await act(() => {
    api.signal('closed', `conversation:${ID}`);
  });
  await flush();
  api.state.window = 'rejoined';
  api.state.failMessages = true;
  const before = api.state.messageReads;
  await act(() => {
    api.signal('conversation', 'board');
  });
  await flush();
  expect(api.state.messageReads).toBeGreaterThan(before);
  expect(page.text()).not.toContain('old-window canary');
});

it('a departed group is not presented as a writable conversation', async () => {
  const api = server();
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  await flush();
  expect(page.find('.tmc__conv .composer')).not.toBeNull();
  api.state.window = 'left';
  await act(() => {
    api.signal('closed', `conversation:${ID}`);
  });
  await flush();
  // The read still permits the historical messages, but withholds the
  // current members and name. send_group and leave now refuse NOT_FOUND.
  expect.soft(page.find('.tmc__conv .composer')).toBeNull();
  expect.soft(page.find('.tmc__conv .tmc__leave')).toBeNull();
});

it('a rejoin no list saw as a leave cannot redraw messages from the earlier window', async () => {
  const api = server();
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  await flush();
  expect(page.text()).toContain('old-window canary');
  // Left and re-added between two list reads: the next list shows only a new join time.
  api.state.window = 'rejoined';
  api.state.failMessages = true;
  const before = api.state.messageReads;
  await act(() => {
    api.signal('conversation', 'board');
  });
  await flush();
  expect(api.state.messageReads).toBeGreaterThan(before);
  expect(page.text()).not.toContain('old-window canary');
});

it('a messages read asked while departed cannot refill the group after a rejoin', async () => {
  const api = server();
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  await flush();
  api.state.window = 'left';
  await act(() => {
    api.signal('closed', `conversation:${ID}`);
  });
  await flush();
  // A read asked while departed answers with the earlier window, but only late.
  const late: (() => void)[] = [];
  api.state.held = late;
  await act(() => {
    api.signal('invalidate', `conversation:${ID}`);
  });
  await flush();
  expect(late).toHaveLength(1);
  api.state.held = null;
  api.state.window = 'rejoined';
  api.state.failMessages = true;
  // The rejoined list lands, then the late read, before the panel draws again.
  await act(async () => {
    api.signal('conversation', 'board');
    for (let turn = 0; turn < 20; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- the list answers first
      await Promise.resolve();
    }
    for (const release of late) release();
    for (let turn = 0; turn < 20; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- then the late read
      await Promise.resolve();
    }
  });
  await flush();
  expect(page.text()).not.toContain('old-window canary');
});
