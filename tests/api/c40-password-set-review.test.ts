// SPDX-License-Identifier: AGPL-3.0-only
//
// C40's reviews, on the reset token (ORCH77-C40B): one token sets one
// password however many requests carry it; a password the provider refuses
// spends the token and ends sessions; and a failure after the provider set
// the password still leaves every session ended.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { json } from './c58-sessions-world.ts';
import {
  answerWith,
  auditOf,
  doorAnswer,
  faultTheChangeIn,
  freshMember,
  inBravoToo,
  mintToken,
  now,
  seen,
  setPassword,
  tokenFor,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();

const NEW_PASSWORD = 'a long new password 9d2e';
const ENDED = 'AUTH_SESSION_EXPIRED';

const answerOf = (answer: { status: number; body: Record<string, unknown> }) => ({
  status: answer.status,
  code: answer.body['code'],
});

const oldSession = async (subject: string) => await tokenFor(subject, randomUUID(), now() - 60);

const REVIEW = it.skipIf(serverUrl === undefined);

REVIEW('C40 F1 two sets at once on one token: one 200, one 401, one admin update', async () => {
  const ann = await freshMember('ann');
  const token = await mintToken(ann.presented.subject);
  const both = await Promise.all([
    setPassword(token, NEW_PASSWORD),
    setPassword(token, 'another long password'),
  ]);
  expect(both.map((one) => one.status).toSorted()).toEqual([200, 401]);
  expect(seen).toHaveLength(1);
});

REVIEW(
  'C40 422 the provider refuses the password: 422 RESET_PASSWORD_REFUSED, token spent',
  async () => {
    const lou = await freshMember('lou');
    const old = await oldSession(lou.presented.subject);
    const token = await mintToken(lou.presented.subject);
    answerWith(json(422, { code: 'weak_password', msg: 'too weak' }));
    expect(answerOf(await setPassword(token, NEW_PASSWORD))).toEqual({
      status: 422,
      code: 'RESET_PASSWORD_REFUSED',
    });
    expect(answerOf(await setPassword(token, NEW_PASSWORD)).code).toBe('RESET_LINK_INVALID');
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
  },
);

REVIEW(
  'C40 L2 the provider answers 500 after a sign-in mid-call: that session is ended',
  async () => {
    const sam = await freshMember('sam');
    const subject = sam.presented.subject;
    let during = '';
    answerWith((request, response) => {
      void tokenFor(subject, randomUUID(), now()).then((token) => {
        during = token;
        json(500, {})(request, response);
        return token;
      });
    });
    const set = await setPassword(await mintToken(subject), NEW_PASSWORD);
    expect(answerOf(set)).toEqual({ status: 503, code: 'RESET_UNAVAILABLE' });
    expect(await doorAnswer(during, 'alpha')).toBe(ENDED);
  },
);

REVIEW(
  'C40 N1 a fault in bravo’s change after the password set: 503, sessions ended in both',
  async () => {
    const tia = await freshMember('tia');
    const subject = tia.presented.subject;
    await inBravoToo(subject, 'tia-in-bravo');
    const old = await oldSession(subject);
    faultTheChangeIn(world.bravo);
    const before = (await auditOf(world.bravo, 'account.password_changed')).length;
    expect(answerOf(await setPassword(await mintToken(subject), NEW_PASSWORD))).toEqual({
      status: 503,
      code: 'RESET_FAULT',
    });
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    expect(await auditOf(world.bravo, 'account.password_changed')).toHaveLength(before);
  },
);

REVIEW(
  'C40 a reset window settles once, at the database’s own moment, whatever the application sends',
  async () => {
    const id = randomUUID();
    const settle = async (at: string) =>
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await tx.query('update ops.subject_resets set settled_at = $2::timestamptz where id = $1', [
          id,
          at,
        ]);
      });
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await tx.query('insert into ops.subject_resets (id, subject_digest) values ($1, $2)', [
        id,
        '0'.repeat(64),
      ]);
    });
    await settle('9999-01-01T00:00:00Z');
    const [row] = await world.db.admin.execute<{ near: boolean }>(
      `select settled_at between clock_timestamp() - interval '1 minute' and clock_timestamp()
         as near from ops.subject_resets where id = $1`,
      [id],
    );
    expect(row?.near).toBe(true);
    await expect(settle('1970-01-01T00:00:00Z')).rejects.toThrow(/already settled/u);
  },
);
