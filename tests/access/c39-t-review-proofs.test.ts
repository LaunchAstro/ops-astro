// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus interim review of C39-T P1 (SL12-18 REV2): the invitation send's
// concurrency ceiling, against the rules AW-07b's send path already keeps.
//
// 1. A send whose process died between `asked` and its observation stays
//    `asked` (unknown, never sent again), but stops holding a place under the
//    ceiling once custody's timeout and the grace have passed, as the inbox
//    send's asks do (`IN_FLIGHT_GRACE_MS`, `aw-07b-in-flight.test.ts`).
//    Otherwise four lost sends stop a business inviting anyone, for good.
// 2. The ceiling is the catalogued one for `email.send`: one bound on provider
//    calls in flight for the business, so inbox emails in flight count
//    against an invitation's send.

import { expect, it as vitestIt } from 'vitest';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { checkItem, recordAsked } from '../../packages/core-custody/src/broker-email.ts';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { itemFor } from '../broker/email-world.ts';
import { c, invite, MAIL, noDatabase, send, useInvitationWorld, w } from './c39-t-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useInvitationWorld();

/** Invitations whose send recorded `asked` and then its process died mid-call. */
async function lostSends(count: number): Promise<string[]> {
  const real = w.broker.custody;
  const dying: typeof real = {
    ...real,
    dispatch: async () => await Promise.reject(new Error('process ended mid-call')),
  };
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const id = await invite(c.admin);
    // oxlint-disable-next-line no-await-in-loop
    await expect(
      sendInvitation(w.db.app, w.alpha, id, { ...w.broker, custody: dying }, MAIL),
    ).rejects.toThrow('process ended mid-call');
    ids.push(id);
  }
  return ids;
}

async function clearAttempts(): Promise<void> {
  await w.db.admin.execute('delete from public.invitation_delivery_attempts');
  await w.db.admin.execute('delete from public.inbox_delivery_attempts');
}

it("C39-T invitation ceiling: a dead send's ask stops holding the invitation ceiling past custody's timeout and the grace", async () => {
  await clearAttempts();
  w.provider.mode('accept');
  const lost = await lostSends(EMAIL_SEND.concurrency);
  // Inside the bound they may be live sends: the ceiling holds.
  const next = await invite(c.admin);
  expect(await send(next)).toEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
  // Past it, custody ended every one of those calls long ago.
  await w.db.admin.execute(
    `update public.invitation_delivery_attempts set observed_at = observed_at - interval '2 minutes'`,
  );
  expect(await send(next)).toMatchObject({ ok: true, state: 'accepted' });
  // A lost send stays unknown: its act is answered, so it is never sent again.
  expect(await send(lost[0] ?? '')).toEqual({ ok: false, code: 'NO_SEND_ACT' });
});

it('C39-T invitation ceiling: inbox emails in flight count against the catalogued email.send ceiling an invitation send takes', async () => {
  await clearAttempts();
  w.provider.mode('accept');
  // The catalogued ceiling's worth of inbox emails, asked and still with the provider.
  const items: string[] = [];
  for (let n = 0; n < EMAIL_SEND.concurrency; n += 1) {
    // oxlint-disable-next-line no-await-in-loop
    items.push(await itemFor(w.task, 'incident'));
  }
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    for (const id of items) {
      // oxlint-disable-next-line no-await-in-loop
      const item = await checkItem(tx, id);
      if (typeof item === 'string') throw new Error(`an item was refused: ${item}`);
      // oxlint-disable-next-line no-await-in-loop
      await recordAsked(tx, [item], false);
    }
  });
  const before = w.provider.received.length;
  const id = await invite(c.admin);
  expect(await send(id)).toEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
  expect(w.provider.received.length).toBe(before);
});
