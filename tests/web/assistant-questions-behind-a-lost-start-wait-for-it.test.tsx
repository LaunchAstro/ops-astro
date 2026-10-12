// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A tab's first question is its start; a question asked while that start is
// out is a message waiting on it, routed so when it is asked. A start whose
// answer is lost keeps its id and the exact payload it sent, and only Send
// again sends it, so the register replays it rather than starting a second
// conversation. A rename or a model chosen meanwhile follows on the recovered
// conversation, never folded into the start sent again.

import { afterEach, expect, it } from 'vitest';
import { settle } from '../surfaces/mount.tsx';
import { doubleClick, press, unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { ask, attemptWire, lines, openDrawer, sendAgain } from './assistant-attempt-wire.tsx';

afterEach(unmountAll);

const FIRST = '44444444-4444-4444-8444-000000000001';

it('two questions sent while the first start is in flight make one conversation, the second sent once as a message with its own words', async () => {
  const wire = attemptWire();
  const page = await openDrawer(wire.client, 'grant-in-flight');
  await ask(page, 'One');
  await ask(page, 'Two');
  expect(wire.calls.map((call) => call.name)).toStrictEqual(['conversation.start']);
  await wire.answer(0);
  expect(wire.calls.map((call) => [call.name, call.body['body']])).toStrictEqual([
    ['conversation.start', 'One'],
    ['conversation.message', 'Two'],
  ]);
  expect(wire.calls[1]?.body).toStrictEqual({ conversationId: FIRST, body: 'Two' });
  await wire.answer(1);
  expect(lines(page)).toStrictEqual(['user: One', 'ai: To One', 'user: Two', 'ai: To Two']);
});

it('a question sent while the tab start has lost its answer starts nothing; Send again recovers the conversation, then it goes once as a message', async () => {
  const wire = attemptWire();
  const page = await openDrawer(wire.client, 'grant-lost-start');
  await ask(page, 'One');
  await ask(page, 'Two');
  await wire.answer(0, 'lost');
  expect(
    wire.calls.map((call) => call.name),
    'a question queued behind a start whose answer was lost started a conversation of its own',
  ).toStrictEqual(['conversation.start']);
  await ask(page, 'Three');
  expect(wire.calls).toHaveLength(1);
  expect(sendAgain(page)).toHaveLength(1);
  await page.click('[data-assistant="send-again"]');
  expect(wire.calls[1]).toMatchObject({
    name: 'conversation.start',
    operationId: wire.calls[0]?.operationId,
    body: wire.calls[0]?.body,
  });
  await wire.answer(1);
  await wire.answer(2);
  await wire.answer(3);
  expect(wire.calls.map((call) => [call.name, call.body['body']])).toStrictEqual([
    ['conversation.start', 'One'],
    ['conversation.start', 'One'],
    ['conversation.message', 'Two'],
    ['conversation.message', 'Three'],
  ]);
  expect(wire.kept('conversation.start'), 'one tab kept two conversations').toBe(1);
  expect(wire.kept('conversation.message')).toBe(2);
  expect(lines(page)).toStrictEqual([
    'user: One',
    'ai: To One',
    'user: Two',
    'ai: To Two',
    'user: Three',
    'ai: To Three',
  ]);
  expect(sendAgain(page)).toHaveLength(0);
});

it('a start sent again after a rename and a model change carries its first payload byte for byte, and the rename and model follow on the recovered conversation', async () => {
  const wire = attemptWire();
  const page = await openDrawer(wire.client, 'grant-frozen-start');
  await ask(page, 'One');
  await wire.answer(0, 'lost');
  await doubleClick(page, '[data-chat="chat-1"]');
  await page.type('[data-chat-rename="chat-1"]', 'Renamed while lost');
  await press(page, '[data-chat-rename="chat-1"]', 'Enter');
  await page.choose('[data-assistant="model"]', 'replay-2');
  await settle();
  expect(wire.calls).toHaveLength(1);
  await page.click('[data-assistant="send-again"]');
  expect(wire.calls[1]?.operationId).toBe(wire.calls[0]?.operationId);
  expect(JSON.stringify(wire.calls[1]?.body), 'the start sent again was not its first').toBe(
    JSON.stringify(wire.calls[0]?.body),
  );
  await wire.answer(1);
  expect(page.text()).not.toContain('OPERATION_ID_REUSED');
  await wire.answer(2);
  expect(wire.calls.slice(2).map((call) => [call.name, call.body])).toStrictEqual([
    ['conversation.rename', { conversationId: FIRST, title: 'Renamed while lost' }],
    ['conversation.set_model', { conversationId: FIRST, model: 'replay-2' }],
  ]);
  expect(wire.kept('conversation.start')).toBe(1);
  expect(lines(page)).toStrictEqual(['user: One', 'ai: To One']);
});
