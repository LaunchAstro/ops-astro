// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question whose answer was lost, resent from the same unstarted tab
// (A then A again), replays its first attempt exactly: the same operation id
// and the same body, with the model, page and title it was first asked with.
// What the person changed in the tab after the loss stays as they left it, and
// reaches the conversation as writes after the replay: a rename, a model and
// a page, in that order, and nothing else. With nothing changed, the page the
// tab gave up on the loss comes back and no write follows the replay.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { bodiesOf, identities } from './replay-drawer.tsx';
import {
  lines,
  opened,
  pickedModel,
  selectedTab,
  standIn,
  tabs,
  tabTitle,
  view,
  type StandIn,
} from './resend-fixture.tsx';

afterEach(unmountAll);

const GIVEN_UP =
  'This page went with the question waiting for its answer. Add it again to ask with it here.';
const noteOf = (address: string): string =>
  `Read this page into context — every widget on ${address}, and nothing else.`;
const P = { address: '/task/T-12', shows: 'Task' };
const P2 = { address: '/task/T-13', shows: 'Task' };
const A = 'Question A';

/** The drawer with model-b and page P chosen, and A asked in chat-2 with its answer lost. */
async function lostWithItsContext(api: StandIn) {
  const moves = await opened(api.client);
  await moves.model('model-b');
  await moves.addPage();
  await moves.ask(A);
  return moves;
}

/** The writes sent, by command, in order. */
const commands = (api: StandIn): string[] => api.bodies.map((one) => one.command);

/** The one conversation the server holds. */
const onlyConversation = (api: StandIn) => {
  expect(api.server.size).toBe(1);
  const [one] = [...api.server.values()];
  if (one === undefined) throw new Error('No conversation was started.');
  return one;
};

/** Both starts went under one operation id with identical bodies: A's first request. */
function replayedAsFirst(api: StandIn): void {
  const starts = bodiesOf(api.bodies, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).toEqual(starts[0]);
  expect(starts[0]).toMatchObject({ body: A, title: 'Chat 2', model: 'model-b', page: P });
  const ids = identities(api.sent, 'conversation.start');
  expect(ids[1]).toBe(ids[0]);
}

it('a first question resent after a loss keeps the title, model and page the person set after it', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const moves = await lostWithItsContext(api);
  expect(lines()).toContain(`note: ${GIVEN_UP}`);
  expect(lines()).not.toContain(`note: ${noteOf(P.address)}`);
  await moves.rename('chat-2', 'Renamed after the loss');
  await moves.model('model-m3');
  await moves.page.render(view(api.client, { here: P2.address }));
  await moves.addPage();
  await moves.ask(A);

  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  expect(selectedTab()).toBe('chat-2');
  expect(tabTitle('chat-2')).toBe('Renamed after the loss');
  expect(pickedModel()).toBe('model-m3');
  expect(lines()).toContain(`note: ${noteOf(P2.address)}`);
  expect(lines().slice(-2)).toEqual([`user: ${A}`, 'ai: An answer.']);

  replayedAsFirst(api);
  const conversation = onlyConversation(api);
  expect(commands(api)).toEqual([
    'conversation.start',
    'conversation.start',
    'conversation.rename',
    'conversation.set_model',
    'conversation.set_scope',
  ]);
  const at = { conversationId: conversation.id };
  expect(bodiesOf(api.bodies, 'conversation.rename')).toEqual([
    { ...at, title: 'Renamed after the loss' },
  ]);
  expect(bodiesOf(api.bodies, 'conversation.set_model')).toEqual([{ ...at, model: 'model-m3' }]);
  expect(bodiesOf(api.bodies, 'conversation.set_scope')).toEqual([{ ...at, page: P2 }]);
  expect(conversation).toMatchObject({
    title: 'Renamed after the loss',
    model: 'model-m3',
    page: P2,
  });
});

it('a first question resent unchanged after a loss puts its page back and sends no write after it', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const moves = await lostWithItsContext(api);
  expect(lines()).toContain(`note: ${GIVEN_UP}`);
  await moves.ask(A);

  expect(selectedTab()).toBe('chat-2');
  expect(tabTitle('chat-2')).toBe('Chat 2');
  expect(pickedModel()).toBe('model-b');
  expect(lines()).toContain(`note: ${noteOf(P.address)}`);
  expect(lines()).not.toContain(`note: ${GIVEN_UP}`);
  expect(lines().slice(-2)).toEqual([`user: ${A}`, 'ai: An answer.']);

  replayedAsFirst(api);
  expect(commands(api)).toEqual(['conversation.start', 'conversation.start']);
  expect(onlyConversation(api)).toMatchObject({ title: 'Chat 2', model: 'model-b', page: P });
});
