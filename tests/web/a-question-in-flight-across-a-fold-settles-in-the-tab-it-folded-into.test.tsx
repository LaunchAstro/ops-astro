// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Sol's proofs for S1917-2 on #1917 (dea3ca8), moved by behaviour (register 73:
// the fix rides in #1920). A question whose send is still out when its tab
// folds settles in the tab it folded into: a replay that succeeds there ends
// its identity, so the same words asked afresh go as a new question; one that
// loses its answer there is kept there, so its resend replays its first
// attempt and the server keeps it once.

import { afterEach, expect, it, vi } from 'vitest';
import { resends, type Asked } from '../../apps/web/src/assistant/resend.ts';
import type { CallResult } from '../../apps/web/src/operations/client.ts';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { identities, opened, settled, standIn, tabs } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a question losing its answer after its tab folds replays its first identity', async () => {
  const api = standIn({ 'conversation.start': ['drop'], 'conversation.message': ['hold-drop'] });
  const drawer = await opened(api.client);
  await drawer.ask('Question A');
  const [id] = api.server.keys();
  if (id === undefined) throw new Error('A was never committed');
  await drawer.reopen(id);
  await drawer.ask('Question B');
  expect(identities(api.sent, 'conversation.message')).toHaveLength(1);
  await drawer.select('chat-2');
  await drawer.ask('Question A');
  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  api.release();
  await settled();
  await drawer.ask('Question B');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect
    .soft(messages[1], 'late loss must retain the same operation in the surviving tab')
    .toBe(messages[0]);
  expect(
    api.server
      .get(id)
      ?.messages.filter((one) => one.role === 'person' && one.body === 'Question B'),
    'the server must commit B once',
  ).toHaveLength(1);
});

it('a moved replay succeeding after a fold clears its identity in the tab it folded into', async () => {
  const resent = resends();
  const asked: Asked = {
    command: 'conversation.message',
    question: 'B',
    request: { conversationId: 'A', body: 'B' },
    baseline: { taskId: 'task-A', revision: 7 },
  };
  const lost = { unavailable: true, because: 'lost' } as const;
  const done = { ok: true, value: {} } as const;
  let firstId = '';
  await resent.send('twin', asked, (_request, id) => {
    firstId = id;
    return Promise.resolve(lost);
  });
  let release!: (result: CallResult<unknown>) => void;
  const replay = resent.send('twin', asked, async (_request, id) => {
    expect(id).toBe(firstId);
    return await new Promise<CallResult<unknown>>((resolve) => {
      release = resolve;
    });
  });
  resent.fold('twin', 'survivor');
  release(done);
  await replay;
  let nextId = '';
  await resent.send('survivor', asked, (_request, id) => {
    nextId = id;
    return Promise.resolve(done);
  });
  expect(nextId, 'a new question after the successful replay needs a new operation').not.toBe(
    firstId,
  );
});

it('a replay completed across a fold never swallows a fresh question with the same words', async () => {
  const api = standIn({ 'conversation.start': ['drop'], 'conversation.message': ['drop'] });
  const mutate = api.client.mutate.bind(api.client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let messages = 0;
  vi.spyOn(api.client, 'mutate').mockImplementation(async (name, body, options) => {
    const result = await mutate(name, body, options);
    if (name === 'conversation.message' && ++messages === 2) await gate;
    return result;
  });
  const drawer = await opened(api.client);
  await drawer.ask('Question A');
  const [id] = api.server.keys();
  if (id === undefined) throw new Error('A was never committed');
  await drawer.reopen(id);
  await drawer.ask('Question B');
  await drawer.ask('Question B');
  expect(messages).toBe(2);
  await drawer.select('chat-2');
  await drawer.ask('Question A');
  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  release();
  await settled();
  await drawer.ask('Question B');
  const sent = identities(api.sent, 'conversation.message');
  expect(sent).toHaveLength(3);
  expect(sent[1]).toBe(sent[0]);
  expect.soft(sent[2], 'the completed question must be new when asked afresh').not.toBe(sent[0]);
  expect(
    api.server
      .get(id)
      ?.messages.filter((one) => one.role === 'person' && one.body === 'Question B'),
    'the fresh question must commit',
  ).toHaveLength(2);
});
