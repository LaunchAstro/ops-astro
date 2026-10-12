// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import {
  broker,
  freshMember,
  mintToken,
  seen,
  setPassword,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';
import { serverUrl } from '../acceptance/world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

usePasswordWorld();

LIVE(
  'a reset paused past its database window never sets the provider password',
  async () => {
    const member = await freshMember('reset-window-late');
    const token = await mintToken(member.presented.subject);
    const original = broker.custody.dispatch.bind(broker.custody);
    const before = seen.length;
    let expired = false;
    const paused = vi
      .spyOn(broker.custody, 'dispatch')
      .mockImplementation(async (credential, request) => {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- polls the window until it lapses
          const [window] = await world.db.admin.execute<{ past: boolean }>(
            `select clock_timestamp() > open_until as past from ops.subject_resets
          where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')
          order by open_until desc limit 1`,
            [member.presented.subject],
          );
          if (window === undefined) throw new Error('reset sent without its durable window');
          if (window.past) {
            expired = true;
            break;
          }
          // oxlint-disable-next-line no-await-in-loop -- polls the window until it lapses
          await delay(1000);
        }
        return await original(credential, request);
      });
    try {
      const answer = await setPassword(token, 'valid late reset password');
      expect({ expired, providerCalls: seen.length - before, status: answer.status }).toEqual({
        expired: true,
        providerCalls: 0,
        status: 503,
      });
    } finally {
      paused.mockRestore();
    }
  },
  360_000,
);
