// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, a reset's window (PR #382 round 3): a session the window refused stays
// refused however the reset ends; a sign-in stamped with the second the window
// settled in is served; and a failed reset's endings reach the session list as
// they reach the door.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { listOwnSessions } from '../../packages/core-commands/src/index.ts';
import { SIGN_IN_CLOCK_SKEW_SECONDS } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { json } from './c58-sessions-world.ts';
import {
  answerWith,
  doorAnswer,
  freshMember,
  mintToken,
  now,
  setPassword,
  tokenFor,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();
const SOL = it.skipIf(serverUrl === undefined);
const PASSWORD = 'a reset window new password';

// PR #382 round 3, criterion 3: a session the window refused stays refused.
SOL('settling a failed reset cannot revive a session refused during the reset', async () => {
  const member = await freshMember('sol-clock-tolerance');
  const subject = member.presented.subject;
  // The verifier explicitly admits first-factor timestamps up to 60 seconds ahead.
  const existing = await tokenFor(subject, randomUUID(), now() + 30);
  expect(await doorAnswer(existing)).toBe('served');
  let during = '';
  let providerError: unknown;
  answerWith((request, response) => {
    void doorAnswer(existing)
      .then((answer) => {
        during = answer;
        json(500, {})(request, response);
        return answer;
      })
      .catch((error: unknown) => {
        providerError = error;
        json(500, {})(request, response);
      });
  });
  const reset = await setPassword(await mintToken(subject), 'sol future clock password');
  expect(providerError).toBeUndefined();
  expect({ status: reset.status, body: reset.body }).toEqual({
    status: 503,
    body: { code: 'RESET_UNAVAILABLE' },
  });
  expect(during).toBe('AUTH_SESSION_EXPIRED');
  expect(await doorAnswer(existing)).toBe('AUTH_SESSION_EXPIRED');
});

/** A reset whose provider answers `status` once `first` was presented mid-call (never before). */
async function presentedMidReset(name: string, status: number) {
  const member = await freshMember(name);
  const subject = member.presented.subject;
  const first = await tokenFor(subject, randomUUID(), now() + 30);
  let during = '';
  answerWith((request, response) => {
    void doorAnswer(first)
      .catch(() => 'error')
      .then((answer) => {
        during = answer;
        json(status, status === 200 ? { id: subject } : {})(request, response);
        return answer;
      });
  });
  const reset = await setPassword(await mintToken(subject), 'a mid reset new password');
  return { reset: reset.status, during, after: await doorAnswer(first) };
}

SOL('C40 window: a session first presented during a failed reset stays refused', async () => {
  expect(await presentedMidReset('first-mid-fail', 500)).toEqual({
    reset: 503,
    during: 'AUTH_SESSION_EXPIRED',
    after: 'AUTH_SESSION_EXPIRED',
  });
});

SOL('C40 window: a session first presented during a successful reset stays refused', async () => {
  expect(await presentedMidReset('first-mid-set', 200)).toEqual({
    reset: 200,
    during: 'AUTH_SESSION_EXPIRED',
    after: 'AUTH_SESSION_EXPIRED',
  });
});

SOL('C40 window: a sign-in stamped with the second a reset settled in is served', async () => {
  const member = await freshMember('settle-second');
  const subject = member.presented.subject;
  expect((await setPassword(await mintToken(subject), PASSWORD)).status).toBe(200);
  const [row] = await world.db.admin.execute<{ second: string }>(
    `select floor(extract(epoch from settled_at))::bigint::text as second from ops.subject_resets
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [subject],
  );
  const second = Number(row?.second);
  // GoTrue stamps whole seconds: the settle's own second may follow it; the one before cannot.
  expect({
    same: await doorAnswer(await tokenFor(subject, randomUUID(), second)),
    before: await doorAnswer(await tokenFor(subject, randomUUID(), second - 1)),
  }).toEqual({ same: 'served', before: 'AUTH_SESSION_EXPIRED' });
});

/** The database clock, in seconds since the epoch. */
const databaseClock = async (): Promise<number> => {
  const [row] = await world.db.admin.execute<{ at: string }>(
    `select extract(epoch from clock_timestamp())::text as at`,
  );
  return Number(row?.at);
};

SOL(
  'C40 window: after a successful reset, a session stamped with the second the provider answered in and never presented is refused',
  async () => {
    const member = await freshMember('answer-second');
    const subject = member.presented.subject;
    let answered = Number.NaN;
    answerWith((request, response) => {
      // Answer just past a whole second of the database's clock, so the reset
      // can settle in the second the provider answered in.
      void databaseClock()
        .then(async (at) => {
          await delay((Math.ceil(at) - at) * 1000 + 20);
          answered = Math.floor(await databaseClock());
          return answered;
        })
        .catch(() => Number.NaN)
        .finally(() => json(200, { id: subject })(request, response));
    });
    expect((await setPassword(await mintToken(subject), PASSWORD)).status).toBe(200);
    expect(Number.isInteger(answered)).toBe(true);
    // An old-password sign-in in that second, made at the provider, never shown to the door.
    expect(await doorAnswer(await tokenFor(subject, randomUUID(), answered))).toBe(
      'AUTH_SESSION_EXPIRED',
    );
  },
);

// PR #382 round 3, correctness: the list agrees with the door after a failed reset.
SOL('the live-session list excludes sessions ended by a failed reset', async () => {
  const member = await freshMember('sol-failed-reset-list');
  const subject = member.presented.subject;
  const oldId = randomUUID();
  const old = await tokenFor(subject, oldId, now() - 60);
  expect(await doorAnswer(old)).toBe('served');
  answerWith(json(500, {}));
  expect((await setPassword(await mintToken(subject), 'sol failed reset password')).status).toBe(
    503,
  );
  expect(await doorAnswer(old)).toBe('AUTH_SESSION_EXPIRED');
  // The failed reset's ending refuses a sign-in up to the clock allowance after it, so move it
  // behind that allowance (as the C58 world's endingsBehind does) before the fresh sign-in.
  await world.db.admin.execute(
    `update ops.ended_subject_sessions
        set ended_before = ended_before - make_interval(secs => $1)
      where subject_digest = encode(sha256(convert_to($2, 'UTF8')), 'hex')`,
    [SIGN_IN_CLOCK_SKEW_SECONDS + 5, subject],
  );
  const freshId = randomUUID();
  const signedInAt = now() + 1;
  const fresh = await tokenFor(subject, freshId, signedInAt);
  const view = await listOwnSessions(
    {
      database: world.db.app,
      businessId: world.alpha,
      accessToken: fresh,
      presented: {
        provider: 'supabase',
        subject,
        sessionId: freshId,
        assurance: { level: 'aal1', signedInAt, factorAt: null },
      },
    },
    {},
  );
  if ('refused' in view) throw new Error('fresh login unexpectedly refused');
  expect(view.sessions.map((session) => session.sessionId)).toEqual([freshId]);
});
