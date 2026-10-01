// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T rate limit and expiry, one lock order: a resend and a create for the
// same address, racing as the invitation lapses, never deadlock. `create`
// ends a lapsed invitation of its address under the limiter's locks, so a
// resend must take the limiter before the invitation's row, as create does.
//
// The race is driven, not hoped for. A third transaction holds the
// invitation's row. The resend starts while the invitation is still live and
// parks; the create starts once the database clock has passed the expiry and
// parks; then the row is let go. Under the other order the resend held the
// row and waited on the limiter the create held, while the create waited on
// the row: the server's deadlock check killed one of them. Each act is one
// transaction here, as `runCommand` runs it: `executeCommand` retries a
// deadlock once, which hides one such cycle behind a second's stall and
// surfaces the next. The other way round, a create parked on the row and a
// resend after it, the resend waits on the create's limiter and finds the
// invitation ended. Either way one invitation for the address is pending.

import { describe, expect, it } from 'vitest';
import { act, delay, holdRow, own, parked, ungranted } from './c39-t-race.ts';
import {
  addressFor,
  c,
  invitationRow,
  invite,
  noDatabase,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

/** Wait until the database clock is past the invitation's expiry. */
async function lapsed(id: string): Promise<void> {
  const [row] = await w.db.admin.execute<{ lapsed: boolean }>(
    'select clock_timestamp() > expires_at as lapsed from public.invitations where id = $1',
    [id],
  );
  if (row?.lapsed === true) return;
  await delay(50);
  await lapsed(id);
}

/** How many invitations for the address are pending, in every business. */
async function pendingFor(address: string): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from public.invitations where address = $1 and state = 'pending'`,
    [address.toLowerCase()],
  );
  return row?.n ?? -1;
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the races that share it
describe.skipIf(noDatabase)('C39-T invitation lock order', () => {
  it('C39-T rate limit: a resend and a create for the same address, racing at expiry, both finish and the resend wins', async () => {
    const address = addressFor('Lock-Order');
    const id = await invite(c.admin, address);
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() + interval '3 seconds' where id = $1`,
      [id],
    );
    const [holder, resender, creator] = [own(), own(), own()] as const;
    try {
      const letGo = await holdRow(holder.db, id);
      // Started while the invitation is live: the resend's own clock says so.
      const resend = act(resender.db, c.admin, {
        command: 'invitation.resend',
        invitationId: id,
      });
      await parked(1, [resender.name]);
      await lapsed(id);
      const create = act(creator.db, c.second, {
        command: 'invitation.create',
        name: 'Lee Lock',
        email: address,
        role: 'member',
      });
      await parked(2, [resender.name, creator.name]);
      await letGo();
      expect(await Promise.all([resend, create])).toEqual(['applied', 'UNIQUE_VALUE_TAKEN']);
      expect(await invitationRow(id)).toMatchObject({ state: 'pending', revision: 2 });
      expect(await pendingFor(address)).toBe(1);
    } finally {
      await Promise.all([holder, resender, creator].map(async (one) => await one.db.close()));
    }
  }, 60_000);

  it('C39-T rate limit: a create parked first and a resend after it, racing at expiry, both finish and the create wins', async () => {
    const address = addressFor('Lock-Order-Create-First');
    const id = await invite(c.admin, address);
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() + interval '2 seconds' where id = $1`,
      [id],
    );
    const [holder, resender, creator] = [own(), own(), own()] as const;
    try {
      const letGo = await holdRow(holder.db, id);
      await lapsed(id);
      // The create holds the address's limiter and waits on the row to end it as lapsed.
      const create = act(creator.db, c.second, {
        command: 'invitation.create',
        name: 'Cy Create',
        email: address,
        role: 'member',
      });
      await parked(1, [creator.name]);
      // The resend waits on that limiter, before it reaches for the row.
      const resend = act(resender.db, c.admin, { command: 'invitation.resend', invitationId: id });
      await parked(2, [creator.name, resender.name]);
      // One advisory lock ungranted, the resend's: it waits on the limiter, not on the row.
      const waits = await ungranted([creator.name, resender.name]);
      expect(waits.filter((lock) => lock.locktype === 'advisory')).toEqual([
        { name: resender.name, locktype: 'advisory' },
      ]);
      await letGo();
      expect(await Promise.all([create, resend])).toEqual(['applied', 'TRANSITION_NOT_PERMITTED']);
      expect(await invitationRow(id)).toMatchObject({ state: 'expired' });
      expect(await pendingFor(address)).toBe(1);
    } finally {
      await Promise.all([holder, resender, creator].map(async (one) => await one.db.close()));
    }
  }, 60_000);
});
