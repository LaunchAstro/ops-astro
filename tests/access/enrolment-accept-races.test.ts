// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each case keeps its schedule in one place */
//
// Accepts beside each other and beside other invitation acts. The accept
// judges everything after its last lock wait, on the clock, in the order
// every invitation writer takes its locks, so two accepts, or an accept
// beside a revoke or a resend, end in one consistent state.
//
// Which act takes the invitation's row first is not fixed. A revoke first
// refuses the accept. A resend only moves the invitation's expiry, and the
// link stays its newest until a send mints the next, so the accept is seated
// whether it takes the row before the resend or after it.

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import { connect, lockAccess } from '../../packages/core-records/src/index.ts';
import { as, c, codeOf, noDatabase, useInvitationWorld, w } from './c39-t-world.ts';
import { invited, latch, NOTHING, seated } from './enrolment-accept-world.ts';

useInvitationWorld();

describe.skipIf(noDatabase)('accepts beside each other and beside other acts', () => {
  it('two accepts of one link at once seat one person once', async () => {
    const { id, token } = await invited();
    const [a, b] = [connect(w.db.appUrl), connect(w.db.appUrl)];
    try {
      const answers = await Promise.all([acceptInvitation(a, token), acceptInvitation(b, token)]);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(await seated(id)).toMatchObject({
        state: 'accepted',
        actors: 1,
        memberships: 1,
        owed: 1,
      });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it.each(['invitation.revoke', 'invitation.resend'])(
    'an accept beside %s ends in one consistent state, with no deadlock',
    async (command) => {
      const { id, token } = await invited();
      const [held, other] = [connect(w.db.appUrl), connect(w.db.appUrl)];
      try {
        // Both queue behind one holder of the access lock, then race for the row.
        const gate = latch();
        const holding = held.withBusiness(w.alpha, async (tx) => {
          await lockAccess(tx);
          await gate.opened;
        });
        await delay(100);
        const accepting = acceptInvitation(other, token);
        const acting = as(c.admin, command, { invitationId: id });
        await delay(300);
        gate.open();
        await holding;
        const [accepted, acted] = await Promise.all([accepting, acting]);
        const state = await seated(id);
        if (command === 'invitation.resend') {
          expect(accepted).toStrictEqual({ ok: true });
          expect(['applied', 'TRANSITION_NOT_PERMITTED']).toContain(codeOf(acted));
          expect(state).toMatchObject({ state: 'accepted', memberships: 1, owed: 1 });
        } else if (accepted.ok) {
          expect(state).toMatchObject({ state: 'accepted', memberships: 1, owed: 1 });
          expect(codeOf(acted)).toBe('TRANSITION_NOT_PERMITTED');
        } else {
          expect(codeOf(acted)).toBe('applied');
          expect(state).toMatchObject({ memberships: 0, owed: 0, spent: 0 });
        }
      } finally {
        await Promise.all([held.close(), other.close()]);
      }
    },
  );

  it('an accept after an applied resend, before its send, is seated on the same link', async () => {
    const { id, token } = await invited();
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    const other = connect(w.db.appUrl);
    try {
      expect(await acceptInvitation(other, token)).toStrictEqual({ ok: true });
      expect(await seated(id)).toMatchObject({ state: 'accepted', memberships: 1, owed: 1 });
    } finally {
      await other.close();
    }
  });

  it('a lifetime that ends while the accept waits on the access lock refuses it', async () => {
    const { id, token } = await invited();
    await w.db.admin.execute(
      `update invitations set expires_at = clock_timestamp() + interval '1500 milliseconds'
        where id = $1`,
      [id],
    );
    const [held, other] = [connect(w.db.appUrl), connect(w.db.appUrl)];
    try {
      const gate = latch();
      const holding = held.withBusiness(w.alpha, async (tx) => {
        await lockAccess(tx);
        await gate.opened;
      });
      await delay(100);
      const accepting = acceptInvitation(other, token);
      await delay(2000);
      gate.open();
      await holding;
      expect(await accepting).toStrictEqual({ ok: false, code: 'ENROLMENT_LINK_INVALID' });
      expect(await seated(id)).toMatchObject(NOTHING);
    } finally {
      await Promise.all([held.close(), other.close()]);
    }
  });
});
