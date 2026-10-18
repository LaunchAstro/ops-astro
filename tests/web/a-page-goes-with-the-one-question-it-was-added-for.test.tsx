// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A page added to a tab goes with one start. When that start's answer is lost,
// the tab gives the page up and says so, so the next question asked there (B)
// never carries it to a second conversation, neither in its start nor in a
// page write after it. A rename, a model and another page made while the lost
// start was held belong to the tab and go in B's start, and no queued write
// reaches either conversation. Resending the lost question carries the page
// only inside its own first attempt's operation.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { bodiesOf, identities, settled } from './replay-drawer.tsx';
import { lines, opened, standIn, view, type StandIn } from './resend-fixture.tsx';

afterEach(unmountAll);

const GIVEN_UP =
  'This page went with the question waiting for its answer. Add it again to ask with it here.';
const P = { address: '/task/T-12', shows: 'Task' };
const P2 = { address: '/task/T-13', shows: 'Task' };
const A = 'Question A';
const B = 'Question B';
const RENAMED = 'Renamed while waiting';

/** The conversation the server started with `question`. */
const conversationOf = (api: StandIn, question: string) => {
  const one = [...api.server.values()].find((each) => each.messages[0]?.body === question);
  if (one === undefined) throw new Error(`No conversation was started with ${question}.`);
  return one;
};

/** Whether a write's body names page P anywhere. */
const carriesP = (body: Readonly<Record<string, unknown>>): boolean =>
  JSON.stringify(body).includes(`"${P.address}"`);

it('a page added for a lost first question never goes with the next question asked in its tab', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const moves = await opened(api.client);
  await moves.addPage();
  await moves.ask(A);
  expect(lines()).toContain(`note: ${GIVEN_UP}`);
  await moves.ask(B);

  const starts = bodiesOf(api.bodies, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[0]).toMatchObject({ body: A, page: P });
  expect(starts[1]).toMatchObject({ body: B });
  expect(starts[1]).not.toHaveProperty('page');
  const b = conversationOf(api, B);
  const scopesToB = bodiesOf(api.bodies, 'conversation.set_scope').filter(
    (body) => body['conversationId'] === b.id,
  );
  expect(scopesToB.filter((body) => carriesP(body))).toEqual([]);
  expect(b.page).toBeNull();
});

/** P added, A held then lost, with a rename, model-m3 and page P2 made while it was held. */
async function changedWhileHeld(api: StandIn) {
  const moves = await opened(api.client);
  await moves.addPage();
  await moves.ask(A);
  await moves.rename('chat-2', RENAMED);
  await moves.model('model-m3');
  await moves.page.render(view(api.client, { here: P2.address }));
  await moves.addPage();
  api.release();
  await settled();
  return moves;
}

/** B's start carries what was made while A was held; only main's start-path page write follows it. */
function bCarriesTheTab(api: StandIn): void {
  const starts = bodiesOf(api.bodies, 'conversation.start');
  expect(starts[1]).toMatchObject({ body: B, title: RENAMED, model: 'model-m3', page: P2 });
  const commands = api.bodies.map((one) => one.command);
  expect(commands).not.toContain('conversation.rename');
  expect(commands).not.toContain('conversation.set_model');
  const b = conversationOf(api, B);
  expect(bodiesOf(api.bodies, 'conversation.set_scope')).toEqual([
    { conversationId: b.id, page: P2 },
  ]);
}

it('changes made while a lost first question was held go with the next start, and its page only with its own replay', async () => {
  const api = standIn({ 'conversation.start': ['hold-drop'] });
  const moves = await changedWhileHeld(api);
  await moves.ask(B);
  bCarriesTheTab(api);
  await moves.ask(A);

  const starts = bodiesOf(api.bodies, 'conversation.start');
  expect(starts).toHaveLength(3);
  expect(starts[0]).toMatchObject({ body: A, page: P });
  expect(starts[2]).toEqual(starts[0]);
  const ids = identities(api.sent, 'conversation.start');
  expect(ids[2]).toBe(ids[0]);
  const withP = api.bodies.filter((one) => carriesP(one.body));
  expect(withP.map((one) => one.command)).toEqual(['conversation.start', 'conversation.start']);
  expect(new Set(withP.map((one) => one.body['operationId']))).toEqual(new Set([ids[0]]));
  expect(conversationOf(api, A).page).toEqual(P);
});
