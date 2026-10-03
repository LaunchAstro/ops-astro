// SPDX-License-Identifier: AGPL-3.0-only
//
// C40 security review (SEC26), through the real API against the stand-in
// provider. A request that lost the claim is recorded in every business the
// login is mapped in (L1). A sign-in made while the provider is still asked,
// after the claim's ending, is ended when the reset fails, whether the answer
// is lost or the first business's change faults, and the recovery session is
// signed out at the provider too (L2). A password the provider refuses
// outright is its own answer: choose another and ask for a new link (422).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { CANARY, json, type Reply } from './c58-sessions-world.ts';
import {
  answerWith,
  attemptsOf,
  auditOf,
  doorAnswer,
  faultTheChangeIn,
  freshMember,
  GOOD,
  inBravoToo,
  now,
  seen,
  setPassword,
  tokenFor,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();

const NEW_PASSWORD = 'a long new password 7f3c';
const INVALID = { status: 401, code: 'RESET_LINK_INVALID' };
const ENDED = 'AUTH_SESSION_EXPIRED';
const SIGNED_OUT = ['PUT /user', 'POST /logout?scope=others', 'POST /logout?scope=local'];

const answerOf = (answer: { status: number; body: Record<string, unknown> }) => ({
  status: answer.status,
  code: answer.body['code'],
});

const routes = (): readonly string[] => seen.map((one) => one.route);

const refusedIn = async (business: string, subject: string): Promise<readonly unknown[]> =>
  (await attemptsOf(business, subject))
    .filter((one) => one.outcome === 'refused')
    .map((one) => one.refusal_code);

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** The same login in alpha and bravo, a session signed in a minute ago, and a reset link's. */
async function bothBusinesses(name: string) {
  const member = await freshMember(name);
  await inBravoToo(member.presented.subject, `${name}-in-bravo`);
  const subject = member.presented.subject;
  const old = await tokenFor(subject, randomUUID(), 'password', now() - 60);
  const recovery = await tokenFor(subject, randomUUID(), 'recovery', now() - 30);
  expect(await doorAnswer(old, 'alpha')).toBe('served');
  expect(await doorAnswer(old, 'bravo')).toBe('served');
  return { member, subject, old, recovery };
}

/**
 * The provider answers `PUT /user` with `reply` only once let go, within the
 * client's time limit: the hold, and the call that lets it go.
 */
function holdTheProvider(reply: Reply): () => void {
  const settle: { resolve?: () => void } = {};
  const released = new Promise<void>((resolve) => {
    settle.resolve = resolve;
  });
  answerWith({
    ...GOOD,
    'PUT /user': (request, response) => {
      void released.then(() => reply(request, response));
    },
  });
  return () => settle.resolve?.();
}

/**
 * Once the held `PUT /user` has reached the provider (the claim committed): a
 * password sign-in whose first factor is a whole second after the claim, made
 * once that second has passed, so any ending from now on reaches it.
 */
async function signInDuringTheCall(subject: string): Promise<string> {
  while (!routes().includes('PUT /user')) {
    // oxlint-disable-next-line no-await-in-loop -- polling the stand-in
    await pause(10);
  }
  const signedInAt = Math.floor((Date.now() + 200) / 1000) + 1;
  while (Date.now() < signedInAt * 1000 + 200) {
    // oxlint-disable-next-line no-await-in-loop -- waiting out the second
    await pause(20);
  }
  return await tokenFor(subject, randomUUID(), 'password', signedInAt);
}

const C40 = describe.skipIf(serverUrl === undefined);

C40('C40 SEC26 L1: the lost claim', () => {
  it('C40 L1 two sets at once, the login in bravo too: the lost claim is recorded in both', async () => {
    const { subject, recovery } = await bothBusinesses('tia');
    const answers = await Promise.all([
      setPassword(recovery, NEW_PASSWORD),
      setPassword(recovery, 'another long new password'),
    ]);
    expect(answers.map((one) => one.status).toSorted((a, b) => a - b)).toEqual([200, 401]);
    expect(routes().filter((route) => route === 'PUT /user')).toHaveLength(1);
    expect(await refusedIn(world.alpha, subject)).toEqual([ENDED]);
    expect(await refusedIn(world.bravo, subject)).toEqual([ENDED]);
  });
});

C40('C40 SEC26 L2: a sign-in during the provider call', () => {
  it('C40 L2a the provider answers 500 after a sign-in mid-call: that session is ended', async () => {
    const { subject, old, recovery } = await bothBusinesses('uli');
    const release = holdTheProvider(json(500, { msg: 'committed, then failed' }));

    const pending = setPassword(recovery, NEW_PASSWORD);
    const during = await signInDuringTheCall(subject);
    expect(await doorAnswer(during, 'alpha')).toBe('served');
    release();

    expect(answerOf(await pending)).toEqual({ status: 503, code: 'RESET_UNAVAILABLE' });
    expect(await doorAnswer(during, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(during, 'bravo')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    expect(routes()).toEqual(SIGNED_OUT);
  });

  it('C40 L2b the first business’s change faults after a sign-in mid-call: that session is ended', async () => {
    const { subject, recovery } = await bothBusinesses('vic');
    faultTheChangeIn(world.alpha);
    const release = holdTheProvider(json(200, { id: subject }));

    const pending = setPassword(recovery, NEW_PASSWORD);
    const during = await signInDuringTheCall(subject);
    expect(await doorAnswer(during, 'bravo')).toBe('served');
    release();

    expect(answerOf(await pending)).toEqual({ status: 503, code: 'RESET_FAULT' });
    expect(await doorAnswer(during, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(during, 'bravo')).toBe(ENDED);
    expect(routes()).toEqual(SIGNED_OUT);
  });
});

C40('C40 SEC26: a password the provider refuses', () => {
  it('C40 422 the provider refuses the password: 422 RESET_PASSWORD_REFUSED, link spent', async () => {
    const { member, old, recovery } = await bothBusinesses('wen');
    answerWith({ ...GOOD, 'PUT /user': json(422, { code: 'weak_password', msg: CANARY }) });

    const set = await setPassword(recovery, NEW_PASSWORD);

    expect(answerOf(set)).toEqual({ status: 422, code: 'RESET_PASSWORD_REFUSED' });
    expect(set.text).not.toContain(CANARY);
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    expect(routes()).toEqual(SIGNED_OUT);
    expect(answerOf(await setPassword(recovery, NEW_PASSWORD))).toEqual(INVALID);
    const audited = await auditOf(world.alpha, 'account.password_changed');
    expect(audited.filter((row) => row.actor_id === member.actorId)).toEqual([]);
  });
});
