// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A question (B) asked in a tab while its first question (A) is still
// starting waits behind A, holding the tab as it was when B was asked, page
// included. When A's answer is then lost, B starts the tab, and the page that
// went with A must not go with B: the check runs when B's start is sent, not
// when B was queued. Across every write sent, the page appears only in A's own
// attempts under A's one operation id, and A resent is its first attempt.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { bodiesOf, identities, settled } from './replay-drawer.tsx';
import { opened, standIn, type StandIn } from './resend-fixture.tsx';

afterEach(unmountAll);

const P = { address: '/task/T-12', shows: 'Task' };
const A = 'Question A';
const B = 'Question B';

/** Whether a write's body names page P anywhere. */
const carriesP = (body: Readonly<Record<string, unknown>>): boolean =>
  JSON.stringify(body).includes(`"${P.address}"`);

/** P added, A sent and held, B queued behind it, a rename and a model made, then A lost. */
async function queuedBehindALostStart(api: StandIn) {
  const moves = await opened(api.client);
  await moves.addPage();
  await moves.ask(A);
  await moves.ask(B);
  await moves.rename('chat-2', 'Renamed while waiting');
  await moves.model('model-m3');
  api.release();
  await settled();
  await settled();
  return moves;
}

it('a question queued behind a lost first question never carries the page that went with it', async () => {
  const api = standIn({ 'conversation.start': ['hold-drop'] });
  const moves = await queuedBehindALostStart(api);

  const starts = bodiesOf(api.bodies, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[0]).toMatchObject({ body: A, page: P });
  expect(starts[1]).toMatchObject({ body: B });
  expect(starts[1]).not.toHaveProperty('page');

  await moves.ask(A);
  const after = bodiesOf(api.bodies, 'conversation.start');
  expect(after).toHaveLength(3);
  expect(after[2]).toEqual(after[0]);
  const ids = identities(api.sent, 'conversation.start');
  expect(ids[2]).toBe(ids[0]);

  const withP = api.bodies.filter((one) => carriesP(one.body));
  expect(withP.map((one) => one.command)).toEqual(['conversation.start', 'conversation.start']);
  expect(withP.map((one) => one.body['body'])).toEqual([A, A]);
  expect(new Set(withP.map((one) => one.body['operationId']))).toEqual(new Set([ids[0]]));
});
