// SPDX-License-Identifier: AGPL-3.0-only
//
// The deadline a reset hands custody is this host's now plus what the
// database says its window has left, so a host clock ten minutes off the
// database's moves the deadline with it: never an absolute database instant,
// which would be ten minutes early or late on this host. Custody is this
// host's own child, on the same clock, so the call it is handed is shifted
// back by the skew before it is sent, and a reset inside its window is set.

import { expect, it, vi } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/commands/account-password.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  broker,
  freshMember,
  mintToken,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

usePasswordWorld();

const TEN_MINUTES = 10 * 60 * 1000;

/** What the subject's window has left, on the database's clock (ms). */
async function leftOf(subject: string): Promise<number> {
  const [row] = await world.db.admin.execute<{ left_ms: number }>(
    `select (extract(epoch from open_until - clock_timestamp()) * 1000)::float8 as left_ms
       from ops.subject_resets
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')
      order by open_until desc limit 1`,
    [subject],
  );
  return Number(row?.left_ms);
}

LIVE.each([TEN_MINUTES, -TEN_MINUTES])(
  'a reset on a host clock %i ms off the database is handed its window left from that clock, and set',
  async (skew) => {
    const member = await freshMember(`reset-skew-${String(skew)}`);
    const token = await mintToken(member.presented.subject);
    const real = Date.now.bind(Date);
    const original = broker.custody.dispatch.bind(broker.custody);
    const handed: { given: number; left: number }[] = [];
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
    const watched = vi
      .spyOn(broker.custody, 'dispatch')
      .mockImplementation(async (credential, request) => {
        const given = Number(request.notAfter) - Date.now();
        handed.push({ given, left: await leftOf(member.presented.subject) });
        // Custody's own clock is this host's: the same deadline, unskewed for the child.
        return await original(credential, {
          ...request,
          notAfter: Number(request.notAfter) - skew,
        });
      });
    let answer: Awaited<ReturnType<typeof setPasswordByToken>>;
    try {
      answer = await setPasswordByToken(
        world.db.app,
        [world.alpha, world.bravo],
        { broker },
        { token, password: 'a skewed host reset password' },
      );
    } finally {
      watched.mockRestore();
      clock.mockRestore();
    }
    const [one] = handed;
    expect({ answer, calls: handed.length }).toEqual({ answer: { ok: true }, calls: 1 });
    // The deadline's distance from this host's now is the window's distance from the database's.
    expect(Number(one?.given)).toBeLessThanOrEqual(Number(one?.left) + 1000);
    expect(Number(one?.given)).toBeGreaterThan(Number(one?.left) - 3000);
  },
  60_000,
);
