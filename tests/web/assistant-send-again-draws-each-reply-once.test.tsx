// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Each question the person sends is one attempt with its own operation id,
// even two with the same words. A lost answer keeps its attempt, and Send
// again resends it under that id; its reply is drawn once, when the attempt
// first settles. Send again is disabled while its resend is out, and a drawer
// remounted for another business or person keeps no attempt of the last one.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { ask, attemptWire, lines, openDrawer, sendAgain } from './assistant-attempt-wire.tsx';

afterEach(unmountAll);

/** A drawer whose first question has started its conversation and been answered. */
async function startedDrawer(grantKey: string) {
  const wire = attemptWire();
  const page = await openDrawer(wire.client, grantKey);
  await ask(page, 'Hello');
  await wire.answer(0);
  return { wire, page };
}

it('two concurrent identical follow-ups are two attempts; one lost then sent again draws each reply once', async () => {
  const { wire, page } = await startedDrawer('grant-twins');
  await ask(page, 'Again?');
  await ask(page, 'Again?');
  const [first, second] = wire.calls.slice(1);
  expect(first?.operationId).not.toBe(second?.operationId);
  await wire.answer(1, 'lost');
  await wire.answer(2);
  expect(sendAgain(page)).toHaveLength(1);
  await page.click('[data-assistant="send-again"]');
  expect(wire.calls[3]).toMatchObject({ operationId: first?.operationId, body: first?.body });
  await wire.answer(3);
  expect(wire.kept('conversation.message')).toBe(2);
  expect(lines(page)).toStrictEqual([
    'user: Hello',
    'ai: To Hello',
    'user: Again?',
    'ai: To Again?',
    'user: Again?',
    'ai: To Again?',
  ]);
  expect(sendAgain(page)).toHaveLength(0);
});

it.each([
  ['in the order sent', [1, 2]],
  ['in reverse', [2, 1]],
])(
  'two questions sent at once, answered %s, each draw their reply after their own question',
  async (_order, order) => {
    const { wire, page } = await startedDrawer(`grant-order-${String(order[0])}`);
    await ask(page, 'First');
    await ask(page, 'Second');
    for (const at of order) {
      // eslint-disable-next-line no-await-in-loop -- answers land one at a time, in this order
      await wire.answer(at);
    }
    expect(lines(page)).toStrictEqual([
      'user: Hello',
      'ai: To Hello',
      'user: First',
      'ai: To First',
      'user: Second',
      'ai: To Second',
    ]);
  },
);

it('Send again is disabled while its resend is out, so a second press sends nothing', async () => {
  const { wire, page } = await startedDrawer('grant-pending');
  await ask(page, 'Once');
  await wire.answer(1, 'lost');
  await page.click('[data-assistant="send-again"]');
  expect(sendAgain(page).map((button) => button.disabled)).toStrictEqual([true]);
  await page.click('[data-assistant="send-again"]');
  expect(wire.calls).toHaveLength(3);
  await wire.answer(2, 'lost');
  expect(sendAgain(page).map((button) => button.disabled)).toStrictEqual([false]);
  await page.click('[data-assistant="send-again"]');
  await wire.answer(3);
  expect(wire.calls.slice(1).map((call) => call.operationId)).toStrictEqual(
    Array.from({ length: 3 }, () => wire.calls[1]?.operationId),
  );
  expect(lines(page).filter((line) => line === 'ai: To Once')).toHaveLength(1);
});

it('a business or person switch remounts the drawer and drops every attempt of the last one', async () => {
  const wire = attemptWire();
  const before = await openDrawer(wire.client, 'grant-before');
  await ask(before, 'Before the switch');
  await wire.answer(0, 'lost');
  expect(sendAgain(before)).toHaveLength(1);
  await before.unmount();
  const after = await openDrawer(wire.client, 'grant-after');
  expect(sendAgain(after)).toHaveLength(0);
  await ask(after, 'After the switch');
  expect(wire.calls[1]).toMatchObject({ name: 'conversation.start' });
  expect(wire.calls[1]?.operationId).not.toBe(wire.calls[0]?.operationId);
  await wire.answer(1);
  expect(lines(after)).toStrictEqual(['user: After the switch', 'ai: To After the switch']);
});
