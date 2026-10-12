// SPDX-License-Identifier: AGPL-3.0-only
//
// The deadline a reset hands custody (`notAfter`) is its window's end, read
// on the database's clock and carried onto this host's: never later than
// `open_until`, however slow the statement that reads it is, before it is
// sent or after it answers. The spend transaction is slowed at that one
// statement; custody's call is watched, and the window read once it settles.

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/commands/account-password.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import {
  broker,
  freshMember,
  mintToken,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();

const SLOW_MS = 1500;

/** The app database, with the window's end read `SLOW_MS` late, before it is sent or after it answers. */
function slowAtTheWindowRead(app: Database, when: 'before' | 'after'): Database {
  return {
    ...app,
    withBusiness: async (business, run) =>
      await app.withBusiness(business, async (tx) => {
        const slowed: typeof tx = {
          ...tx,
          query: async <Row>(text: string, parameters?: readonly unknown[]) => {
            if (!text.includes('left_ms')) return await tx.query<Row>(text, parameters);
            if (when === 'before') await delay(SLOW_MS);
            const rows = await tx.query<Row>(text, parameters);
            if (when === 'after') await delay(SLOW_MS);
            return rows;
          },
        };
        return await run(slowed);
      }),
  };
}

/** The database clock's offset from this host's (ms), and how far off that reading may be. */
async function clockOffset(): Promise<{ offset: number; within: number }> {
  const sent = Date.now();
  const [row] = await world.db.admin.execute<{ readonly at: number }>(
    'select (extract(epoch from clock_timestamp()) * 1000)::float8 as at',
  );
  const back = Date.now();
  return { offset: Number(row?.at) - (sent + back) / 2, within: (back - sent) / 2 + 1 };
}

it.each(['before', 'after'] as const)(
  'a reset whose window end is read slowly (%s the statement) is sent with a deadline no later than that end',
  async (when) => {
    const member = await freshMember(`reset-deadline-${when}`);
    const token = await mintToken(member.presented.subject);
    const handed: (number | undefined)[] = [];
    const original = broker.custody.dispatch.bind(broker.custody);
    const watched = vi
      .spyOn(broker.custody, 'dispatch')
      .mockImplementation(async (credential, request) => {
        handed.push(request.notAfter);
        return await original(credential, request);
      });
    let answer: Awaited<ReturnType<typeof setPasswordByToken>>;
    try {
      answer = await setPasswordByToken(
        slowAtTheWindowRead(world.db.app, when),
        [world.alpha, world.bravo],
        { broker },
        { token, password: `valid ${when} reset password` },
      );
    } finally {
      watched.mockRestore();
    }
    const [window] = await world.db.admin.execute<{ readonly until: number }>(
      `select (extract(epoch from open_until) * 1000)::float8 as until from ops.subject_resets
        where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')
        order by open_until desc limit 1`,
      [member.presented.subject],
    );
    const { offset, within } = await clockOffset();
    // The window's end on this host's clock.
    const end = Number(window?.until) - offset;
    const [notAfter] = handed;
    expect({ answer, calls: handed.length, typed: typeof notAfter }).toEqual({
      answer: { ok: true },
      calls: 1,
      typed: 'number',
    });
    expect(Number(notAfter), 'never past the window').toBeLessThanOrEqual(end + within);
    // Early by no more than the slow statement and the transaction around it.
    expect(Number(notAfter)).toBeGreaterThan(end - within - SLOW_MS - 2_000);
  },
  60_000,
);
