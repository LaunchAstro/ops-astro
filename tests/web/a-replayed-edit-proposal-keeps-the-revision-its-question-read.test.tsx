// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question whose answer was lost is resent and its first attempt
// replayed, edit proposal and all. That proposal was made against the task as
// it was read before the first attempt, so it stays bound to that revision: a
// task changed meanwhile makes the card stale rather than letting the old
// proposal overwrite the newer work.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { EDIT, REPLY } from '../surfaces/chat-proposal-drawer.tsx';
import { drawer, identities, standIn, TASK } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a replayed edit proposal keeps the task revision its first attempt read', async () => {
  let revision = 7;
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
  const kept = JSON.parse(
    sessionStorage.getItem('ops-astro:proposal-baselines:resend-proof') ?? '{}',
  );
  expect(kept[REPLY], 'the proposal is bound to what its question read').toEqual({
    taskId: TASK.id,
    revision: 7,
  });
});

it('a replayed edit proposal whose first attempt read no task stays unbound, never bound to a later read', async () => {
  let revision = -1;
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
  revision = 8;
  await ask('Tighten the brief');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts[1], 'the resend replays the first attempt').toBe(starts[0]);
  const kept = JSON.parse(
    sessionStorage.getItem('ops-astro:proposal-baselines:resend-proof') ?? '{}',
  ) as Record<string, unknown>;
  expect(kept[REPLY], 'no revision the question never read').toBeUndefined();
});
