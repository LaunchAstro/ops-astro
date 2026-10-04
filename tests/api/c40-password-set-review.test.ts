// SPDX-License-Identifier: AGPL-3.0-only
//
// C40's reviews, on the reset token (ORCH77-C40B): one token sets one
// password however many requests carry it; a password the provider refuses
// spends the token and ends sessions; a login with a verified second factor
// gives its code, checked by us under the wrong-code lockout; and a failure
// after the provider set the password still leaves every session ended.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { json } from './c58-sessions-world.ts';
import {
  answerWith,
  auditOf,
  doorAnswer,
  faultTheChangeIn,
  freshMember,
  GOOD_CODE,
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

/** A new member of alpha whose login has a verified second factor. */
async function withFactor(name: string) {
  const member = await freshMember(name);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const local = await recordFactorEnrolled(tx, {
      personId: member.personId,
      provider: 'supabase',
      providerFactorId: randomUUID(),
    });
    await recordFactorVerified(tx, {
      personId: member.personId,
      factorId: local.id,
      subject: member.presented.subject,
    });
  });
  return member;
}

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
  'C40 F5 a login with a verified factor resets only with its code, checked by us',
  async () => {
    const kit = await withFactor('kit');
    const token = await mintToken(kit.presented.subject);
    const none = await setPassword(token, NEW_PASSWORD);
    const wrong = await setPassword(token, NEW_PASSWORD, '000000');
    expect([answerOf(none), answerOf(wrong)]).toEqual([
      { status: 401, code: 'RESET_FACTOR_INVALID' },
      { status: 401, code: 'RESET_FACTOR_INVALID' },
    ]);
    expect(seen).toEqual([]);
    // The token was not spent: with the code, it sets the password, and the factor stays.
    expect((await setPassword(token, NEW_PASSWORD, GOOD_CODE)).status).toBe(200);
    const [person] = await world.db.app.withBusiness(
      world.alpha,
      async (tx) =>
        await tx.query<{ verified: boolean }>(
          'select second_factor_verified as verified from people where id = $1',
          [kit.personId],
        ),
    );
    expect(person?.verified).toBe(true);
  },
);

REVIEW('C40 F5 lockout: after five wrong codes even the good one is refused', async () => {
  const rex = await withFactor('rex');
  const token = await mintToken(rex.presented.subject);
  for (let tried = 0; tried < 5; tried += 1) {
    // oxlint-disable-next-line no-await-in-loop
    expect((await setPassword(token, NEW_PASSWORD, '111111')).status).toBe(401);
  }
  expect(answerOf(await setPassword(token, NEW_PASSWORD, GOOD_CODE))).toEqual({
    status: 429,
    code: 'SECOND_FACTOR_LOCKED',
  });
  expect(seen).toEqual([]);
});

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
