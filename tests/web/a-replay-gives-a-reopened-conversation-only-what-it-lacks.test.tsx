// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question asked with a model and a page loses its answer, and its
// conversation is reopened from the history, where the read gives it neither
// (a read carries no model, and a reopened tab no page), and the person renames
// it there. Another question starts the asking tab, and the first is resent:
// the reopened tab takes the model and the page from the question's own kept
// attempt, keeps the title the person gave it, and nothing more is written.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { lines, opened, pickedModel, selectedTab, standIn, tabTitle } from './resend-fixture.tsx';

afterEach(unmountAll);

const A = 'Question A';
const P_NOTE = 'note: Read this page into context — every widget on /task/T-12, and nothing else.';

it('a replay into a reopened conversation fills its model and page and keeps its title', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const drawer = await opened(api.client);
  await drawer.model('model-b');
  await drawer.addPage();
  await drawer.ask(A);
  const [conversation] = api.server.keys();
  if (conversation === undefined) throw new Error('A was never committed');
  await drawer.reopen(conversation);
  expect(selectedTab(), 'the history opens A as its own tab').toBe('chat-3');
  await drawer.rename('chat-3', 'Named in the history');
  await drawer.select('chat-2');
  await drawer.ask('Question B');
  const before = api.bodies.length;
  await drawer.ask(A);
  expect(selectedTab(), 'the replay answers in the tab already on A').toBe('chat-3');
  expect(pickedModel(), "A's own model, which the read never gave").toBe('model-b');
  expect(lines(), "A's own page, which the reopened tab never had").toContain(P_NOTE);
  expect(tabTitle('chat-3'), 'a title the person set stays').toBe('Named in the history');
  const after = api.bodies.slice(before).map((one) => one.command);
  expect(after, 'the replay alone, with no write after it').toEqual(['conversation.start']);
});
