// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #897: a lost first question whose answer proposes a task, replayed after
// another question started the tab: accepting the proposal creates the task
// from the replayed question's own conversation, never the tab's newer one.
// From the review's proof, tightened: the create button must be there, and
// its click sends exactly one `task.create`, with A's conversation as its
// origin.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { CREATE } from '../surfaces/chat-proposal-drawer.tsx';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { bodiesOf, drawer, settled, standIn } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a replayed task proposal keeps its originating conversation', async () => {
  const api = standIn(
    { 'conversation.start': ['drop'] },
    {},
    {
      reply: (question) => ({
        answered: true,
        body: question === 'Question A' ? CREATE : 'An ordinary answer.',
        cites: [],
      }),
    },
  );
  const ask = await drawer(api.client);
  await ask('Question A', 'Question B', 'Question A');
  const origin = [...api.server.values()].find((one) => one.messages[0]?.body === 'Question A');
  expect(origin, "A's conversation").toBeDefined();
  // Only A's answer proposes a task, and its card carries A's origin, even
  // though the asking tab is now on B's conversation.
  const button = document.querySelector<HTMLButtonElement>('[data-proposal="send"]');
  expect(button, 'the create card is offered').not.toBeNull();
  act(() => {
    button?.click();
  });
  await settled();
  expect(bodiesOf(api.bodies, 'task.create').map((body) => body['conversationId'])).toEqual([
    origin?.id,
  ]);
});
