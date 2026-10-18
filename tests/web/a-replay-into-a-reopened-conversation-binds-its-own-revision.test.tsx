// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question on a task, read at revision 7, loses its answer, and its
// conversation is reopened from the history. The task moves on to revision 8,
// another question starts the asking tab, and the first question is resent.
// Its replay answers in the tab already open on its conversation: that tab is
// selected, on the task, keeps the line asked there since, and shows the
// question and its answer once each. The answer's edit card applies at the
// revision its question read (7), never a later one. With the history read
// still out when the replay lands, the replay opens the conversation's tab,
// and the read that lands later only selects it.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { pathTo } from '../../apps/web/src/routes.ts';
import { EDIT } from '../surfaces/chat-proposal-drawer.tsx';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { bodiesOf, identities } from './replay-drawer.tsx';
import {
  lines,
  opened,
  selectedTab,
  settled,
  standIn,
  tabs,
  TASK,
  type StandIn,
} from './resend-fixture.tsx';

afterEach(unmountAll);

const A = 'Question A';
const LATER = 'A later line';

/** Question A's answer proposes an edit to the task; every other question gets a plain answer. */
function onTask() {
  let revision = 7;
  const api = standIn(
    { 'conversation.start': ['drop'] },
    {},
    {
      revision: () => revision,
      reply: (question) =>
        question === A
          ? { answered: true, body: EDIT, cites: [] }
          : { answered: true, body: 'An answer.', cites: [] },
    },
  );
  return { api, moveTo: (at: number) => (revision = at) };
}

/** The conversation the server keeps for question A. */
const conversationOf = (api: StandIn): string => {
  const found = [...api.server.values()].find((one) => one.messages[0]?.body === A);
  if (found === undefined) throw new Error('no conversation holds question A');
  return found.id;
};

const count = (prefix: string): number => lines().filter((line) => line.startsWith(prefix)).length;

/** The selected tab's conversation address, subject and input placeholder. */
const shown = () => {
  const input = document.querySelector<HTMLInputElement>('[data-assistant="input"]');
  return {
    address: document.querySelector('[data-assistant="address"]')?.getAttribute('href'),
    subject: input?.getAttribute('aria-label'),
    placeholder: input?.placeholder,
  };
};

/** The selected tab shows A's question once, and A's edit answer once, after it. */
function showsAOnce(): void {
  expect(count(`user: ${A}`), "A's question, once").toBe(1);
  expect(count('ai: Here is a task for that.'), "A's answer, once").toBe(1);
  const question = lines().indexOf(`user: ${A}`);
  expect(lines()[question + 1], "A's answer straight after A's question").toMatch(
    /^ai: Here is a task for that\./u,
  );
}

/** A real click on the selected tab's edit card, and the task writes it sent. */
async function clickEdit(api: StandIn) {
  const button = document.querySelector<HTMLButtonElement>('[data-proposal="send"]');
  expect(button, "A's edit card is offered in the selected tab").not.toBeNull();
  expect(button?.disabled).toBe(false);
  const before = api.bodies.length;
  act(() => {
    button?.click();
  });
  await settled();
  return api.bodies.slice(before).filter((one) => one.command === 'task.update');
}

/** What the selected tab shows when it is open on `conversation`, on the task. */
const onTheTask = (conversation: string) => ({
  address: pathTo('agency:agent-conversation', { conversation }),
  subject: `Ask the agent about ${TASK.title}`,
  placeholder: 'Ask about this task…',
});

/** The card's click sent one `task.update`, for the task, at the revision A's question read. */
async function appliesAtSeven(api: StandIn): Promise<void> {
  const updates = await clickEdit(api);
  expect(updates.map((one) => one.body['recordId'])).toEqual([TASK.id]);
  expect(updates.map((one) => one.body['expectedRevision'])).toEqual([7]);
}

it('a replay into a conversation reopened from the history answers there once, bound to the revision its question read', async () => {
  const { api, moveTo } = onTask();
  const moves = await opened(api.client);
  await moves.ask(A);
  const conversation = conversationOf(api);
  await moves.reopen(conversation);
  expect(tabs()).toEqual(['chat-1', 'chat-2', 'chat-3']);
  showsAOnce();
  await moves.ask(LATER);
  moveTo(8);
  await moves.select('chat-2');
  await moves.ask('Question B');
  await moves.ask(A);
  expect(selectedTab(), "the tab open on A's conversation").toBe('chat-3');
  expect(shown()).toEqual(onTheTask(conversation));
  showsAOnce();
  expect(count(`user: ${LATER}`), 'the line asked there since stays').toBe(1);
  expect(lines().indexOf(`user: ${LATER}`)).toBeGreaterThan(lines().indexOf(`user: ${A}`) + 1);
  await appliesAtSeven(api);
  const starts = identities(api.sent, 'conversation.start');
  expect(starts, 'A, B, then A replayed under its first identity').toEqual([
    starts[0],
    starts[1],
    starts[0],
  ]);
});

it('a replay landing while the history read of its conversation is still out opens one tab on it, bound to the revision its question read', async () => {
  const { api, moveTo } = onTask();
  const moves = await opened(api.client);
  await moves.ask(A);
  const conversation = conversationOf(api);
  api.holdReads(1);
  await moves.reopen(conversation);
  expect(tabs(), 'the read is out: no tab yet').toEqual(['chat-1', 'chat-2']);
  moveTo(8);
  await moves.select('chat-2');
  await moves.ask('Question B');
  await moves.ask(A);
  expect(tabs(), "a new tab on A's conversation").toEqual(['chat-1', 'chat-2', 'chat-3']);
  expect(selectedTab()).toBe('chat-3');
  expect(shown()).toEqual(onTheTask(conversation));
  showsAOnce();
  api.releaseRead();
  await settled();
  expect(tabs(), 'the late read opens no second tab on it').toEqual(['chat-1', 'chat-2', 'chat-3']);
  expect(selectedTab()).toBe('chat-3');
  showsAOnce();
  await appliesAtSeven(api);
  expect(bodiesOf(api.bodies, 'conversation.set_scope'), 'a replay sends no page').toEqual([]);
});
