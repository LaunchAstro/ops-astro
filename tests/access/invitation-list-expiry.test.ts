// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the case keeps its schedule in one place */
//
// The invitation list judges a lifetime on the clock when it reads, not at
// its transaction's start: an invitation whose lifetime ends while the read
// waits in login resolution is listed as expired, never as pending.
import { describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { c, invite, noDatabase, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

describe.skipIf(noDatabase)('the invitation list after a wait', () => {
  it('an invitation expiring during login resolution is listed as expired', async () => {
    const id = await invite(c.admin);
    const observerUrl = new URL(
      process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'] ?? '',
    );
    observerUrl.pathname = `/${w.db.name}`;
    const observer = connectAsAdmin(observerUrl.toString());
    let reading: ReturnType<typeof executeRead> | undefined;
    try {
      await w.db.admin.transaction(async (execute) => {
        // A genuine database wait before the read handler, on the authentication
        // record that executeRead writes during login resolution.
        await execute('lock table public.authentication_attempts in access exclusive mode');
        reading = executeRead(w.db.app, w.alpha, c.second.presented, {
          read: 'invitation.list',
        });
        let blocked = false;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop -- polls until the read waits on the lock
          const [row] = await observer.execute<{ blocked: boolean }>(
            `select exists(select 1 from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and query like 'insert into public.authentication_attempts%') as blocked`,
          );
          if (row?.blocked === true) {
            blocked = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop -- one short pause between polls
          await observer.execute('select pg_sleep(0.01)');
        }
        expect(blocked, 'executeRead is waiting inside its already started transaction').toBe(true);
        await execute(
          `update public.invitations set expires_at = clock_timestamp() + interval '100 milliseconds'
            where id = $1`,
          [id],
        );
        await execute('select pg_sleep(0.2)');
      });
      const result = await reading;
      expect(result).toHaveProperty('invitations');
      if (result === undefined || !('invitations' in result)) throw new Error('list was refused');
      const listed = result.invitations.find((row) => row.invitationId === id);
      expect(
        Date.parse(listed?.expiresAt ?? ''),
        'the returned lifetime has already passed',
      ).toBeLessThan(Date.now());
      expect(listed?.state).toBe('expired');
    } finally {
      await reading;
      await observer.close();
    }
  });
});
