// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset's call with the provider ends at its window's end (`notAfter`), not
// at the operation's timeout: a provider holding its answer across that end
// gets the call cut there. The answer is RESET_UNAVAILABLE, never set, and the
// window settles, so the room is free for the next reset.

import { expect, it } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/commands/account-password.ts';
import { AUTH_UPDATE_USER_PASSWORD, catalogue } from '../../packages/core-connectors/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { json } from './c58-sessions-world.ts';
import {
  answerWith,
  broker,
  freshMember,
  mintToken,
  seen,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

usePasswordWorld();

/** What the window has left when its end is read, and how long the provider holds its answer. */
const LEFT_MS = 1500;
const HELD_MS = 5000;

/** The world's broker with the operation's own timeout, well past the window's end. */
const patient = (): Broker => ({
  ...broker,
  operations: catalogue([{ ...AUTH_UPDATE_USER_PASSWORD, timeoutMs: 10_000 }]),
});

/** The app database, read as though the window had `LEFT_MS` left when its end is read. */
function nearItsEnd(app: Database): Database {
  return {
    ...app,
    withBusiness: async (business, run) =>
      await app.withBusiness(business, async (tx) => {
        const near: typeof tx = {
          ...tx,
          query: async <Row>(text: string, parameters?: readonly unknown[]) => {
            const rows = await tx.query<Row>(text, parameters);
            if (!text.includes('left_ms')) return rows;
            // oxlint-disable-next-line no-map-spread -- each row copied with its time left cut
            return rows.map((row) => ({ ...row, left_ms: LEFT_MS }));
          },
        };
        return await run(near);
      }),
  };
}

/** The subject's windows still taking room: open and unsettled. */
const openWindowsOf = async (subject: string): Promise<number> => {
  const [row] = await world.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from ops.subject_resets
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')
        and settled_at is null and open_until > clock_timestamp()`,
    [subject],
  );
  return row?.n ?? 0;
};

LIVE(
  'a reset whose provider holds its answer past the window end is cut there and never set',
  async () => {
    const member = await freshMember('reset-held-answer');
    const token = await mintToken(member.presented.subject);
    answerWith((request, response) => {
      const id = (request.url ?? '').split('/').at(-1) ?? '';
      setTimeout(() => {
        json(200, { id, email: 'x@example.test', aud: 'authenticated' })(request, response);
      }, HELD_MS);
    });
    const before = seen.length;
    const started = Date.now();
    const answer = await setPasswordByToken(
      nearItsEnd(world.db.app),
      [world.alpha, world.bravo],
      { broker: patient() },
      { token, password: 'a held answer password' },
    );
    const took = Date.now() - started;
    expect({
      answer,
      reached: seen.length - before,
      cutBeforeTheAnswer: took < HELD_MS,
      open: await openWindowsOf(member.presented.subject),
    }).toEqual({
      answer: { ok: false, code: 'RESET_UNAVAILABLE' },
      reached: 1,
      cutBeforeTheAnswer: true,
      open: 0,
    });
  },
  30_000,
);
