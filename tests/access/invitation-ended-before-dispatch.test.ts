// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's send releases the invitation's lock when its reservation
// commits, before custody is asked. A revoke, or the invitation's expiry,
// that lands in that gap is caught by a read just before dispatch: the
// provider hears nothing, and the attempt ends `failed`, `not_pending`,
// which proves nothing went. The database handed to the send runs the
// revoke or the expiry just before the send's second transaction, the first
// after its reservation.

import { describe, expect, it } from 'vitest';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { as, c, codeOf, invite, MAIL, noDatabase, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

/** The world's app database, running `between` once, just before the send's second transaction. */
function gapAfterReservation(between: () => Promise<void>): Database {
  let calls = 0;
  return {
    ...w.db.app,
    withBusiness: async (businessId, run) => {
      calls += 1;
      if (calls === 2) await between();
      return await w.db.app.withBusiness(businessId, run);
    },
  };
}

const outcomesOf = async (
  id: string,
): Promise<readonly { state: string; evidence: string | null }[]> =>
  await w.db.admin.execute<{ state: string; evidence: string | null }>(
    `select state, evidence from public.invitation_delivery_attempts
      where invitation_id = $1 order by observed_at, state`,
    [id],
  );

describe.skipIf(noDatabase)('an invitation ended between its reservation and its dispatch', () => {
  it('a revoke committed after the reservation stops the dispatch; nothing reaches the provider', async () => {
    const id = await invite(c.admin);
    const before = w.provider.received.length;
    const database = gapAfterReservation(async () => {
      const revoked = await as(c.admin, 'invitation.revoke', { invitationId: id });
      expect(codeOf(revoked)).toBe('applied');
    });
    const result = await sendInvitation(database, w.alpha, id, w.broker, MAIL);
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault: 'not_pending' });
    expect(w.provider.received.length).toBe(before);
    expect(await outcomesOf(id)).toEqual([
      { state: 'asked', evidence: null },
      { state: 'failed', evidence: 'not_pending' },
    ]);
  });

  it('an expiry passed after the reservation stops the dispatch; nothing reaches the provider', async () => {
    const id = await invite(c.admin);
    const before = w.provider.received.length;
    const database = gapAfterReservation(async () => {
      await w.db.admin.execute(
        "update public.invitations set expires_at = clock_timestamp() - interval '1 second' where id = $1",
        [id],
      );
    });
    const result = await sendInvitation(database, w.alpha, id, w.broker, MAIL);
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault: 'not_pending' });
    expect(w.provider.received.length).toBe(before);
  });

  it('with nothing in the gap the same send goes once', async () => {
    const id = await invite(c.admin);
    const before = w.provider.received.length;
    const result = await sendInvitation(
      gapAfterReservation(async () => {}),
      w.alpha,
      id,
      w.broker,
      MAIL,
    );
    expect(result).toMatchObject({ ok: true, state: 'accepted' });
    expect(w.provider.received.length).toBe(before + 1);
  });
});
