// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { c, invite, MAIL, received, useInvitationWorld, w } from './c39-t-world.ts';
import { serverUrl } from '../acceptance/world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

useInvitationWorld();

LIVE(
  'an invitation expiring between the broker check and custody dispatch is not emailed',
  async () => {
    const id = await invite(c.admin);
    await w.db.admin.execute(
      "update public.invitations set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
      [id],
    );
    const before = received();
    let expiredAtDispatch = false;
    const custody = {
      ...w.custody,
      dispatch: async (...args: Parameters<typeof w.custody.dispatch>) => {
        for (let check = 0; check < 200; check++) {
          // oxlint-disable-next-line no-await-in-loop -- polls one row until it expires
          const [row] = await w.db.admin.execute<{ expired: boolean }>(
            'select expires_at <= clock_timestamp() as expired from public.invitations where id = $1',
            [id],
          );
          if (row?.expired === true) {
            expiredAtDispatch = true;
            break;
          }
          // oxlint-disable-next-line no-await-in-loop -- polls one row until it expires
          await delay(20);
        }
        expect(expiredAtDispatch).toBe(true);
        return await w.custody.dispatch(...args);
      },
    };
    const result = await sendInvitation(w.db.app, w.alpha, id, { ...w.broker, custody }, MAIL);
    expect(expiredAtDispatch).toBe(true);
    expect(received() - before).toBe(0);
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_FAILED' });
  },
);
