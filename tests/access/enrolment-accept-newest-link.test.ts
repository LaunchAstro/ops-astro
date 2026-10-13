// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the case keeps its schedule in one place */
//
// Only the newest enrolment link of an invitation is live, and newest means
// the last minted: a send that began before another but reached the
// invitation's lock after it mints the newer link, which the accept takes.
import { expect, it } from 'vitest';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import {
  as,
  c,
  codeOf,
  linkIn,
  MAIL,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';
import { invited, latch } from './enrolment-accept-world.ts';

useInvitationWorld();

it.skipIf(noDatabase)(
  'the last invitation link minted is accepted when the sends began in the other order',
  async () => {
    const { id } = await invited();
    // Two applied resends leave two sends owed. Both are legitimate sends.
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    const early = connect(w.db.appUrl);
    const entered = latch();
    const release = latch();
    const delayed: Database = {
      log: early.log,
      close: async () => await early.close(),
      withBusiness: async (business, run) =>
        await early.withBusiness(business, async (tx) => {
          // A real open transaction, before it reaches the invitation's row lock.
          entered.open();
          await release.opened;
          return await run(tx);
        }),
    };
    const lateMint = sendInvitation(delayed, w.alpha, id, w.broker, MAIL);
    try {
      await entered.opened;
      expect(await send(id)).toMatchObject({ ok: true });
      const prior = linkIn(w.provider.outbox.at(-1)?.body).token;
      release.open();
      expect(await lateMint).toMatchObject({ ok: true });
      const newest = linkIn(w.provider.outbox.at(-1)?.body).token;
      expect(newest).not.toBe(prior);
      expect(await acceptInvitation(w.db.app, newest)).toStrictEqual({ ok: true });
    } finally {
      release.open();
      await lateMint;
      await early.close();
    }
  },
);
