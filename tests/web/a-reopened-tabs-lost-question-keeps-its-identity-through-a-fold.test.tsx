// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Sol's proof for S1917-1 on #1917 (d4f18b8), moved by behaviour. A first
// question loses its answer, its conversation is reopened from the history,
// and a later question asked there loses its answer too. The first question
// resent in its own tab folds the reopened tab in; the later question resent
// from the folded tab replays its own first attempt, so the server keeps it
// once, never twice.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { identities, opened, standIn, tabs } from './resend-fixture.tsx';

afterEach(unmountAll);

it("a reopened tab's lost question keeps its identity when the tab folds", async () => {
  const api = standIn({ 'conversation.start': ['drop'], 'conversation.message': ['drop'] });
  const drawer = await opened(api.client);
  await drawer.ask('Question A');
  const [id] = api.server.keys();
  if (id === undefined) throw new Error('A was never committed');
  await drawer.reopen(id);
  await drawer.ask('Question B');
  await drawer.select('chat-2');
  await drawer.ask('Question A');
  expect(tabs(), 'the reopened tab folded into the asking tab').toEqual(['chat-1', 'chat-2']);
  await drawer.ask('Question B');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1], 'the resend replays the first message operation').toBe(messages[0]);
  const asked = api.server.get(id)?.messages.filter((one) => one.body === 'Question B') ?? [];
  expect(asked, 'the server keeps question B once').toHaveLength(1);
});
