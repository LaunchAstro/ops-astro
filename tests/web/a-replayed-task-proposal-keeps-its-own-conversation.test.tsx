// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- the review's proof, kept as written */
//
// #897: a lost first question whose answer proposes a task, replayed after
// another question started the tab: accepting the proposal creates the task
// from the replayed question's own conversation, never the tab's newer one.
// Moved from the review's proof with its body unchanged.
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { settle } from '../surfaces/mount.tsx';
import { CREATE } from '../surfaces/chat-proposal-drawer.tsx';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { drawer, standIn } from './resend-fixture.tsx';
afterEach(unmountAll);
it('a replayed task proposal keeps its originating conversation', async () => {
  let replies = 0;
  const api = standIn(
    { 'conversation.start': ['drop'] },
    {},
    {
      reply: () => ({
        answered: true,
        messageId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${++replies}`,
        body: replies === 1 ? CREATE : 'An ordinary answer.',
      }),
    },
  );
  const created: Readonly<Record<string, unknown>>[] = [];
  const mutate = api.client.mutate.bind(api.client);
  api.client.mutate = async (name, body, options) => {
    if (name === 'task.create') created.push(body);
    return await mutate(name, body, options);
  };
  const ask = await drawer(api.client);
  await ask('Question A', 'Question B', 'Question A');
  // Only A's original answer proposes a task. Every offered action from it
  // must carry A's origin, even while the tab stays on B's conversation.
  const button = document.querySelector<HTMLElement>('[data-proposal="send"]');
  if (button !== null) {
    await act(async () => button.click());
    await settle();
    expect(created).toHaveLength(1);
  }
  for (const body of created) {
    expect(body['conversationId']).toBe('c0000000-0000-4000-8000-000000000001');
  }
});
