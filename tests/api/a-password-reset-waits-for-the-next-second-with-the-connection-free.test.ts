// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset that set the password settles in a later whole second than the
// provider's answer, on the database's clock (C40). The API's pool holds one
// connection, so that wait is spent with the connection free: another
// request asked during it is served at once, not after the reset's second
// turns over. Real Postgres, custody and the provider's stand-in.

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  answerWith,
  broker,
  freshMember,
  mintToken,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';
import { json } from './c58-sessions-world.ts';

usePasswordWorld();

/** The database's clock, in seconds since the epoch. */
async function clock(): Promise<number> {
  const [row] = await world.db.admin.execute<{ readonly at: number }>(
    'select extract(epoch from clock_timestamp())::float8 as at',
  );
  return row?.at ?? Number.NaN;
}

it.skipIf(serverUrl === undefined)(
  "a password reset's wait for the next second leaves the API's one connection free",
  async () => {
    const member = await freshMember('settle-wait');
    const token = await mintToken(member.presented.subject);
    let answeredAt = Number.NaN;
    let answered!: () => void;
    const answering = new Promise<void>((resolve) => {
      answered = resolve;
    });
    answerWith((request, response) => {
      void (async () => {
        answeredAt = await clock();
        const id = (request.url ?? '').split('/').at(-1) ?? '';
        json(200, { id, email: 'x@example.test', aud: 'authenticated' })(request, response);
        answered();
      })();
    });
    // Start just past a whole second, so most of a second is left to wait.
    const at = await clock();
    await delay((Math.ceil(at) - at) * 1000 + 20);
    const reset = setPasswordByToken(
      world.db.app,
      [world.alpha, world.bravo],
      { broker },
      { token, password: 'a new password for the wait' },
    );
    await answering;
    await delay(100);
    const asked = performance.now();
    await world.db.app.withBusiness(world.alpha, async (tx) => await tx.query('select 1'));
    const servedMs = performance.now() - asked;
    expect(await reset).toStrictEqual({ ok: true });
    const [settle] = await world.db.admin.execute<{ readonly at: number }>(
      `select extract(epoch from settled_at)::float8 as at from ops.subject_resets
        where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [member.presented.subject],
    );
    const leftToWait = Math.ceil(answeredAt) - answeredAt;
    expect({
      waitLeftWhenAsked: leftToWait > 0.4,
      servedWithinTheWait: servedMs < 200,
      settledInALaterSecond: Math.floor(settle?.at ?? 0) > Math.floor(answeredAt),
    }).toStrictEqual({
      waitLeftWhenAsked: true,
      servedWithinTheWait: true,
      settledInALaterSecond: true,
    });
  },
  60_000,
);
