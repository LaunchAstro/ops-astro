// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question whose answer was lost is resent and its first attempt
// replayed, edit proposal and all. That proposal was made against the task as
// it was read before the first attempt, so it stays bound to that revision: a
// task changed meanwhile makes the card stale rather than letting the old
// proposal overwrite the newer work. A first attempt that read no task leaves
// the replayed card unbound, never bound to a later read.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { UNBOUND_EDIT } from '../../apps/web/src/assistant/proposals.ts';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { EDIT, REPLY } from '../surfaces/chat-proposal-drawer.tsx';
import {
  bodiesOf,
  drawer,
  identities,
  settled,
  standIn,
  TASK,
  type StandIn,
} from './resend-fixture.tsx';

afterEach(unmountAll);

/** A lost first question proposing an edit, asked at `first`, resent once the task is at 8. */
async function replayedAt(first: number): Promise<StandIn> {
  let revision = first;
  const api = standIn(
    { 'conversation.start': ['drop'] },
    {},
    {
      revision: () => revision,
      reply: () => ({ answered: true, messageId: REPLY, body: EDIT, cites: [] }),
    },
  );
  const ask = await drawer(api.client);
  await ask('Tighten the brief');
  // Someone else's edit lands while the first answer is lost.
  revision = 8;
  await ask('Tighten the brief');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1], 'the resend replays the first attempt').toBe(starts[0]);
  return api;
}

/** A real click on the tab's edit card. */
async function apply(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('[data-proposal="send"]');
  expect(button, 'the edit card is offered').not.toBeNull();
  act(() => {
    button?.click();
  });
  await settled();
}

it('a replayed edit proposal keeps the task revision its first attempt read', async () => {
  const api = await replayedAt(7);
  await apply();
  const updates = bodiesOf(api.bodies, 'task.update');
  expect(
    updates.map((body) => [body['recordId'], body['expectedRevision']]),
    'the proposal is bound to what its question read',
  ).toEqual([[TASK.id, 7]]);
});

it('a replayed edit proposal whose first attempt read no task stays unbound, never bound to a later read', async () => {
  // A negative revision stands for a read that failed.
  const api = await replayedAt(-1);
  await apply();
  expect(bodiesOf(api.bodies, 'task.update'), 'no revision the question never read').toEqual([]);
  expect(document.querySelector('[data-proposal="refusal"]')?.textContent).toBe(UNBOUND_EDIT);
});
