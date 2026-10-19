// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question whose answer was lost (A), then another question (B) that
// started the same tab, then A resent (A, B, A). The changes made after A's
// loss belong to the tab and go with B's start. A's replay is its first
// attempt exactly, and it answers in a new tab of its own, selected, that
// opens with A's own title, model and page, while the asking tab says where
// the answer went and keeps everything made after A. No rename, model or page
// write follows the replay.

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
const APART = 'Already asked in a conversation of its own: its answer is in that tab.';
const noteOf = (address: string): string =>
  `Read this page into context — every widget on ${address}, and nothing else.`;
const P = { address: '/task/T-12', shows: 'Task' };
const P2 = { address: '/task/T-13', shows: 'Task' };
const A = 'Question A';
const B = 'Question B';
const RENAMED = 'Renamed after the loss';

/** A asked in chat-2 with model-b and page P, lost, then the tab renamed, model-m3 and page P2. */
async function lostThenChanged(api: StandIn) {
  const moves = await opened(api.client);
  await moves.model('model-b');
  await moves.addPage();
  await moves.ask(A);
  expect(lines()).toContain(`note: ${GIVEN_UP}`);
  await moves.rename('chat-2', RENAMED);
  await moves.model('model-m3');
  await moves.page.render(view(api.client, { here: P2.address }));
  await moves.addPage();
  return moves;
}

/** The conversation the server started with `question`. */
const conversationOf = (api: StandIn, question: string) => {
  const one = [...api.server.values()].find((each) => each.messages[0]?.body === question);
  if (one === undefined) throw new Error(`No conversation was started with ${question}.`);
  return one;
};

/** Three starts: A, B with the tab's new values, then A again as its first attempt. */
function startsOfABA(api: StandIn): void {
  const starts = bodiesOf(api.bodies, 'conversation.start');
  expect(starts).toHaveLength(3);
  expect(starts[0]).toMatchObject({ body: A, title: 'Chat 2', model: 'model-b', page: P });
  expect(starts[1]).toMatchObject({ body: B, title: RENAMED, model: 'model-m3', page: P2 });
  expect(starts[2]).toEqual(starts[0]);
  const ids = identities(api.sent, 'conversation.start');
  expect(ids[2]).toBe(ids[0]);
  expect(ids[1]).not.toBe(ids[0]);
}

/** Every write: the three starts and main's one set_scope straight after B's start, nothing more. */
function onlyTheStartsWrote(api: StandIn): void {
  expect(api.bodies.map((one) => one.command)).toEqual([
    'conversation.start',
    'conversation.start',
    'conversation.set_scope',
    'conversation.start',
  ]);
  const b = conversationOf(api, B);
  expect(bodiesOf(api.bodies, 'conversation.set_scope')).toEqual([
    { conversationId: b.id, page: P2 },
  ]);
}

it('a first question replayed after another started its tab opens in a tab of its own, with its own context', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const moves = await lostThenChanged(api);
  await moves.ask(B);
  expect(lines().slice(-2)).toEqual([`user: ${B}`, 'ai: An answer.']);
  await moves.ask(A);

  expect(tabs()).toEqual(['chat-1', 'chat-2', 'chat-3']);
  expect(selectedTab()).toBe('chat-3');
  expect(tabTitle('chat-3')).toBe('Chat 2');
  expect(pickedModel()).toBe('model-b');
  expect(lines()).toContain(`note: ${noteOf(P.address)}`);
  expect(lines()).not.toContain(`note: ${GIVEN_UP}`);
  const asked = lines().filter((line) => line.startsWith('user: ') || line.startsWith('ai: '));
  expect(asked).toEqual([`user: ${A}`, 'ai: An answer.']);

  await moves.select('chat-2');
  expect(tabTitle('chat-2')).toBe(RENAMED);
  expect(pickedModel()).toBe('model-m3');
  expect(lines()).toContain(`note: ${noteOf(P2.address)}`);
  expect(lines()).toContain(`note: ${APART}`);

  startsOfABA(api);
  onlyTheStartsWrote(api);
  expect(conversationOf(api, A)).toMatchObject({ title: 'Chat 2', model: 'model-b', page: P });
  expect(conversationOf(api, B)).toMatchObject({ title: RENAMED, model: 'model-m3', page: P2 });
  expect(api.server.size).toBe(2);
});
