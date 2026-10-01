// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (SL12-18, the mail-timing and mail-hook joins): the daily
// batch (fork A) sends one email for several items and records the same
// `provider:<id>` on each; the hook (fork B) moves one attempt by that id
// (`limit 1`), so a bounce or a delivery of a batch email lands on one item
// and leaves the others `accepted` for good.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { emailDailyBatch } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from '../broker/email-world.ts';
import { eventBody, mountHook, post } from '../broker/email-hook-world.ts';
import { freshInbox, timing, useTimingWorld } from '../broker/email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();
beforeAll(() => {
  mountHook();
});

const states = async (item: string): Promise<readonly string[]> =>
  (await attemptsOf(item)).map((row) => row.state);

it('a bounce of a batch email is recorded on every item it covered', async () => {
  await freshInbox();
  const items = [await itemFor(w.task, 'mention'), await itemFor(w.task, 'assignment')];
  expect(await emailDailyBatch(w.db.app, w.alpha, w.person, timing())).toMatchObject({
    ok: true,
    items: 2,
  });
  const messageId = w.provider.outbox.at(-1)?.id;
  if (messageId === undefined) throw new Error('the outbox is empty');
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await states(item)).toEqual(['asked', 'accepted']);
  }
  expect(await post(eventBody('email.bounced', messageId))).toMatchObject({ code: 'BOUNCED' });
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await states(item), item).toEqual(['asked', 'accepted', 'failed']);
  }
});
