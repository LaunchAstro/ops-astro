// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question commits, and its conversation is reopened from the
// history before its answer commits, so the history tab reads the question
// alone. Then the answer commits and the asking tab loses the response. A
// later line is asked in the history tab, another question starts the asking
// tab, and the first question is resent. Its replay gives the history tab the
// one answer it was missing, straight after the question and before the later
// line, and that answer's edit card applies at the revision its question read
// (7). Asking the same words again in the asking tab adds nothing there.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { EDIT } from '../surfaces/chat-proposal-drawer.tsx';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import {
  identities,
  lines,
  opened,
  settled,
  standIn,
  TASK,
  type StandIn,
} from './resend-fixture.tsx';

afterEach(unmountAll);

const A = 'Question A';
const LATER = 'A later line';
const EDIT_ANSWER = 'ai: Here is a task for that.';

/** Question A's answer proposes an edit to the task, and commits apart from its question. */
function splitOnTask() {
  let revision = 7;
  const api = standIn(
    { 'conversation.start': ['split-drop'] },
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
const conversationOf = (api: StandIn) => {
  const found = [...api.server.values()].find((one) => one.messages[0]?.body === A);
  if (found === undefined) throw new Error('no conversation holds question A');
  return found;
};

/** The selected tab's lines, each answer cut to its first words. */
const shortLines = (): string[] =>
  lines().map((line) => (line.startsWith(EDIT_ANSWER) ? EDIT_ANSWER : line));

/** A real click on the selected tab's edit card, and the `task.update`s it sent. */
async function clickEdit(api: StandIn) {
  const button = document.querySelector<HTMLButtonElement>('[data-proposal="send"]');
  expect(button, "A's edit card is offered in the history tab").not.toBeNull();
  expect(button?.disabled, 'and can be clicked').toBe(false);
  const before = api.bodies.length;
  act(() => {
    button?.click();
  });
  await settled();
  return api.bodies.slice(before).filter((one) => one.command === 'task.update');
}

/** A sent and held, its conversation reopened with the question alone, then its response lost. */
async function reopenedBeforeTheAnswer(api: StandIn) {
  const moves = await opened(api.client);
  await moves.ask(A);
  const conversation = conversationOf(api);
  expect(
    conversation.messages.map((one) => one.role),
    'the question alone',
  ).toEqual(['person']);
  await moves.reopen(conversation.id);
  expect(shortLines(), 'the history tab read the question alone').toEqual([`user: ${A}`]);
  api.release();
  await settled();
  expect(
    conversation.messages.map((one) => one.role),
    'the answer committed',
  ).toEqual(['person', 'agent']);
  return moves;
}

it('a replay gives a reopened conversation the answer its read was missing, once, bound to the revision its question read', async () => {
  const { api, moveTo } = splitOnTask();
  const moves = await reopenedBeforeTheAnswer(api);
  await moves.ask(LATER);
  moveTo(8);
  await moves.select('chat-2');
  await moves.ask('Question B');
  await moves.ask(A);
  await moves.select('chat-3');
  expect(shortLines(), "A's answer between A's question and the later line").toEqual([
    `user: ${A}`,
    EDIT_ANSWER,
    `user: ${LATER}`,
    'ai: An answer.',
  ]);
  const updates = await clickEdit(api);
  expect(updates.map((one) => one.body['recordId'])).toEqual([TASK.id]);
  expect(updates.map((one) => one.body['expectedRevision'])).toEqual([7]);
  const starts = identities(api.sent, 'conversation.start');
  expect(starts, 'A, B, then A replayed under its first identity').toEqual([
    starts[0],
    starts[1],
    starts[0],
  ]);
});

it('the same words asked again after the replay add nothing to the reopened conversation', async () => {
  const { api } = splitOnTask();
  const moves = await reopenedBeforeTheAnswer(api);
  await moves.ask(LATER);
  await moves.select('chat-2');
  await moves.ask('Question B', A);
  await moves.select('chat-3');
  const after = shortLines();
  expect(
    after.filter((line) => line === EDIT_ANSWER),
    "A's answer, once",
  ).toHaveLength(1);
  await moves.select('chat-2');
  await moves.ask(A);
  await moves.select('chat-3');
  expect(shortLines(), 'nothing more').toEqual(after);
  expect(identities(api.sent, 'conversation.start'), 'no start after the replay').toHaveLength(3);
});
