// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question loses its answer in a tab not yet started, and its
// conversation is reopened from the history as a second tab, where the person
// changes it. When the first question's start lands in the first tab, the
// reopened twin folds in. The folded tab keeps the most recent change to each
// of title, model and page, by the drawer's own counter, the server ends
// holding the same, and the twin's lost question keeps its own identity. A
// start still in flight while its conversation is reopened folds the same way.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import {
  bodiesOf,
  identities,
  lines,
  opened,
  pickedModel,
  settled,
  standIn,
  tabs,
  tabTitle,
  view,
  type StandIn,
} from './resend-fixture.tsx';

afterEach(unmountAll);

const A = 'Question A';
const P3 = { address: '/task/T-13', shows: 'Task' };
const P3_NOTE = 'note: Read this page into context — every widget on /task/T-13, and nothing else.';

const conversationOf = (api: StandIn): string => {
  const [id] = api.server.keys();
  if (id === undefined) throw new Error('A was never committed');
  return id;
};

it('a replay folding a reopened twin keeps the title, model and page set there', async () => {
  const api = standIn({
    'conversation.start': ['drop'],
    'conversation.message': ['drop'],
    'conversation.set_scope': ['late'],
  });
  const drawer = await opened(api.client);
  await drawer.ask(A);
  const a = conversationOf(api);
  await drawer.reopen(a);
  await drawer.rename('chat-3', 'Named in the twin');
  await drawer.model('model-m3');
  await drawer.ask('Twin question');
  await drawer.page.render(view(api.client, { here: P3.address }));
  await drawer.addPage();
  await drawer.select('chat-2');
  await drawer.ask(A);
  expect(tabs(), 'the twin folds in: one tab on A').toEqual(['chat-1', 'chat-2']);
  expect(tabTitle('chat-2')).toBe('Named in the twin');
  expect(pickedModel()).toBe('model-m3');
  expect(lines()).toContain(P3_NOTE);
  api.release();
  await settled();
  const held = api.server.get(a);
  expect([held?.title, held?.model, held?.page]).toEqual(['Named in the twin', 'model-m3', P3]);
  await drawer.ask('Twin question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages, "the twin's lost question replays its own identity").toHaveLength(2);
  expect(messages[1]).toBe(messages[0]);
  const asked = held?.messages.filter((one) => one.body === 'Twin question') ?? [];
  expect(asked, 'committed once').toHaveLength(1);
  await drawer.ask('After the fold');
  const last = bodiesOf(api.bodies, 'conversation.message').at(-1);
  expect(last?.['conversationId']).toBe(a);
});

it("a change made in the asking tab after the twin's wins, written after the twin's held write", async () => {
  const api = standIn({ 'conversation.start': ['drop'], 'conversation.set_model': ['late'] });
  const drawer = await opened(api.client);
  await drawer.ask(A);
  const a = conversationOf(api);
  await drawer.reopen(a);
  await drawer.model('model-m3');
  await drawer.select('chat-2');
  await drawer.model('model-b');
  await drawer.ask(A);
  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  expect(pickedModel(), "the asking tab's later choice").toBe('model-b');
  api.release();
  await settled();
  const models = bodiesOf(api.bodies, 'conversation.set_model').map((one) => one['model']);
  expect(models, "one set_model, after the twin's held one").toEqual(['model-m3', 'model-b']);
  expect(api.server.get(a)?.model).toBe('model-b');
});

it("a start still in flight folds a twin reopened meanwhile and keeps the twin's title", async () => {
  const api = standIn({ 'conversation.start': ['hold'] });
  const drawer = await opened(api.client);
  await drawer.ask(A);
  const a = conversationOf(api);
  await drawer.reopen(a);
  await drawer.rename('chat-3', 'Named in the twin');
  api.release();
  await settled();
  await settled();
  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  expect(tabTitle('chat-2')).toBe('Named in the twin');
  expect(api.server.get(a)?.title).toBe('Named in the twin');
  expect(bodiesOf(api.bodies, 'conversation.rename').map((one) => one['title'])).toEqual([
    'Named in the twin',
  ]);
});
