// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P1: an invitation's email takes its place under `email.send`'s
// catalogued concurrency as AW-07b's inbox email does. One ceiling bounds the
// provider: inbox and invitation emails in flight count together under one
// lock. And an invitation ask whose sender died before recording an outcome
// stays `asked` (unknown, never sent again) but stops holding a place once
// custody's own timeout and a grace have passed, so four lost sends never hold
// a business's invitations at the ceiling for good.

import { describe, expect, it } from 'vitest';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { checkItem, recordAsked } from '../../packages/core-custody/src/broker-email.ts';
import { emailAtOnce, sendInvitation } from '../../packages/core-custody/src/index.ts';
import { aged, freshInbox, timing } from '../broker/email-timing-world.ts';
import { itemFor } from '../broker/email-world.ts';
import {
  c,
  countFor,
  invite,
  MAIL,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

/** Every invitation attempt recorded so far is this much older. */
async function agedInvitations(interval: string): Promise<void> {
  await w.db.admin.execute(
    `update public.invitation_delivery_attempts set observed_at = observed_at - $1::interval`,
    [interval],
  );
}

/** Invitations whose sender recorded `asked`, committed, then died in the provider call. */
async function invitationsGone(count: number): Promise<string[]> {
  const real = w.broker.custody;
  const custody: typeof real = {
    ...real,
    dispatch: async () => await Promise.reject(new Error('sender died')),
  };
  const lost: string[] = [];
  for (let n = 0; n < count; n += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const id = await invite(c.admin);
    // oxlint-disable-next-line no-await-in-loop
    await expect(
      sendInvitation(w.db.app, w.alpha, id, { ...w.broker, custody }, MAIL),
    ).rejects.toThrow('sender died');
    lost.push(id);
  }
  return lost;
}

/** Inbox emails whose sender recorded `asked`, committed, then died: one email each. */
async function inboxGone(count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const id = await itemFor(w.task, 'incident');
    // oxlint-disable-next-line no-await-in-loop
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      const item = await checkItem(tx, id);
      if (typeof item === 'string') throw new Error(`an item was refused: ${item}`);
      await recordAsked(tx, [item], false);
    });
  }
}

const atOnce = async (item: string) => await emailAtOnce(w.db.app, w.alpha, item, timing());

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invitation ceiling', () => {
  it("C39-T one ceiling: inbox and invitation emails in flight share email.send's catalogued concurrency", async () => {
    await freshInbox();
    await agedInvitations('8 days');
    const invitations = Math.floor(EMAIL_SEND.concurrency / 2);
    await invitationsGone(invitations);
    await inboxGone(EMAIL_SEND.concurrency - invitations);
    // Together they fill the ceiling: neither kind of email may start another.
    const id = await invite(c.admin);
    expect(await send(id)).toStrictEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
    expect(await countFor('enrolment_tokens', id)).toBe(0);
    const decision = await itemFor(w.task, 'decision');
    expect(await atOnce(decision)).toStrictEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
    // Past custody's timeout and the grace, neither holds a place.
    await aged('2 minutes');
    await agedInvitations('2 minutes');
    expect(await send(id)).toMatchObject({ ok: true, state: 'accepted' });
    expect(await atOnce(decision)).toMatchObject({ ok: true, state: 'accepted' });
  });

  it("C39-T ceiling: a dead sender's invitation asks stop holding the ceiling past custody's timeout and a grace", async () => {
    await freshInbox();
    await agedInvitations('8 days');
    const lost = await invitationsGone(EMAIL_SEND.concurrency);
    // Inside the bound they may be live sends: four tokens in flight hold the ceiling.
    const id = await invite(c.admin);
    expect(await send(id)).toStrictEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
    expect(await countFor('enrolment_tokens', id)).toBe(0);
    expect(await countFor('invitation_delivery_attempts', id)).toBe(0);
    // Past it (custody ended every one of those calls long ago), they hold nothing.
    await agedInvitations('2 minutes');
    expect(await send(id)).toMatchObject({ ok: true, state: 'accepted' });
    // A lost ask stays unknown: its act is answered, so it is never sent again.
    const [first = ''] = lost;
    expect(await send(first)).toStrictEqual({ ok: false, code: 'NO_SEND_ACT' });
    const states = await w.db.admin.execute<{ state: string }>(
      'select state from public.invitation_delivery_attempts where invitation_id = $1',
      [first],
    );
    expect(states.map((row) => row.state)).toStrictEqual(['asked']);
  });
});
