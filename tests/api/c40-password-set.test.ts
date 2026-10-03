// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, link use, through the real API against a stand-in login provider: the
// reset link's recovery session sets the new password, and every session of
// the login ends, in every business it reaches, here and at the provider.
// The recovery session is good for that and nothing else, and once.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { CANARY, HOSTILE, json } from './c58-sessions-world.ts';
import {
  answerWith,
  attemptsOf,
  auditOf,
  clientA,
  clientB,
  doorAnswer,
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
const CHANGED = 'account.password_changed';
const INVALID = { status: 401, code: 'RESET_LINK_INVALID' };
const ENDED = 'AUTH_SESSION_EXPIRED';

const answerOf = (answer: { status: number; body: Record<string, unknown> }) => ({
  status: answer.status,
  code: answer.body['code'],
});

/** A session signed in a minute ago, and the reset link's session opened since. */
async function sessionsOf(subject: string) {
  const old = await tokenFor(subject, randomUUID(), 'password', now() - 60);
  const recovery = await tokenFor(subject, randomUUID(), 'recovery', now() - 30);
  return { old, recovery };
}

const C40 = describe.skipIf(serverUrl === undefined);

C40('C40 password reset, link use: sessions', () => {
  it('C40 other sessions end: the new password ends every session, in every business', async () => {
    const mia = await freshMember('mia');
    await inBravoToo(mia.presented.subject, 'mia-in-bravo');
    const { old, recovery } = await sessionsOf(mia.presented.subject);
    expect(await doorAnswer(old, 'alpha')).toBe('served');
    expect(await doorAnswer(old, 'bravo')).toBe('served');

    const set = await setPassword(recovery, NEW_PASSWORD);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ signedOutAtProvider: true });

    // Ended here from the commit, in both businesses, the reset's own session too.
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    // At the provider: the password set, then the others' refresh tokens and this one revoked.
    expect(seen.map((one) => one.route)).toEqual([
      'PUT /user',
      'POST /logout?scope=others',
      'POST /logout?scope=local',
    ]);
    expect(seen.every((one) => one.authorization === `Bearer ${recovery}`)).toBe(true);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ password: NEW_PASSWORD });
    // A sign-in with the new password, after the reset, is served.
    const after = await tokenFor(mia.presented.subject, randomUUID(), 'password', now() + 1);
    expect(await doorAnswer(after, 'alpha')).toBe('served');
  });
});

C40('C40 password reset, link use: the link', () => {
  it('C40 signed-out reset: a spent, expired or ordinary session sets nothing', async () => {
    const noah = await freshMember('noah');
    const { recovery } = await sessionsOf(noah.presented.subject);
    // A recovery session is good for the new password only: no business serves it.
    expect(await doorAnswer(recovery, 'alpha')).toBe(ENDED);
    expect((await setPassword(recovery, NEW_PASSWORD)).status).toBe(200);
    seen.length = 0;

    // The same link's session again: spent.
    expect(answerOf(await setPassword(recovery, 'another long password'))).toEqual(INVALID);
    // A recovery session past its expiry, and an ordinary sign-in, are no reset link.
    const late = await tokenFor(noah.presented.subject, randomUUID(), 'recovery', now(), now() - 5);
    expect(answerOf(await setPassword(late, NEW_PASSWORD))).toEqual(INVALID);
    const fresh = await tokenFor(noah.presented.subject, randomUUID(), 'password', now() + 1);
    expect(answerOf(await setPassword(fresh, NEW_PASSWORD))).toEqual(INVALID);
    expect(await doorAnswer(fresh, 'alpha')).toBe('served');
    // No bearer, and a recovery session of a login no business maps.
    expect(answerOf(await setPassword(undefined, NEW_PASSWORD))).toEqual(INVALID);
    const stranger = await tokenFor(`stranger-${randomUUID()}`, randomUUID(), 'recovery', now());
    expect(answerOf(await setPassword(stranger, NEW_PASSWORD))).toEqual(INVALID);
    // A password out of bounds, from a live recovery session.
    const next = await tokenFor(noah.presented.subject, randomUUID(), 'recovery', now() + 1);
    expect(answerOf(await setPassword(next, 'short'))).toEqual({
      status: 400,
      code: 'PASSWORD_INVALID',
    });
    expect(seen).toEqual([]);
  });
});

C40('C40 password reset, link use: the provider', () => {
  it('C40 hostile provider: a wrong answer to the password set audits nothing', async () => {
    const bea = await freshMember('bea');
    const hostile = {
      ...HOSTILE,
      'a 200 naming another user': json(200, { id: 'someone-else', msg: CANARY }),
      'a 200 with no user': json(200, { msg: CANARY }),
    };
    const { old } = await sessionsOf(bea.presented.subject);
    // One wrong answer at a time, each from a clean stand-in, each on a link of
    // its own opened after the last ending: a fault spends the link it came on
    // and ends the login's sessions, and the person asks again.
    for (const [name, reply] of Object.entries(hostile)) {
      answerWith({ ...GOOD, 'PUT /user': reply });
      seen.length = 0;
      // oxlint-disable-next-line no-await-in-loop
      const recovery = await tokenFor(bea.presented.subject, randomUUID(), 'recovery', now() + 1);
      // oxlint-disable-next-line no-await-in-loop
      const set = await setPassword(recovery, NEW_PASSWORD);
      expect(answerOf(set), name).toEqual({ status: 503, code: 'RESET_UNAVAILABLE' });
      expect(set.text, name).not.toContain(CANARY);
      // The others signed out at the provider too, in case it set the password,
      // then the spent link's own session.
      expect(
        seen.map((one) => one.route),
        name,
      ).toEqual(['PUT /user', 'POST /logout?scope=others', 'POST /logout?scope=local']);
      // oxlint-disable-next-line no-await-in-loop
      expect(answerOf(await setPassword(recovery, NEW_PASSWORD)), name).toEqual(INVALID);
    }
    // The claim ended every session of the login here before the provider was asked.
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    const audited = await auditOf(world.alpha, CHANGED);
    expect(audited.filter((row) => row.actor_id === bea.actorId)).toEqual([]);
  });
});

C40('C40 password reset, link use: secrets', () => {
  it('C40 token canary: the password and link session reach no answer, audit or attempt row, or log', async () => {
    const ivy = await freshMember('ivy');
    const password = `${CANARY}-password`;
    const { recovery } = await sessionsOf(ivy.presented.subject);
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    try {
      answerWith({ ...GOOD, 'POST /logout?scope=others': json(500, { msg: CANARY }) });
      const set = await setPassword(recovery, password);
      expect(set.status).toBe(200);
      expect(set.body).toEqual({ signedOutAtProvider: false });
      const again = await setPassword(recovery, password);
      for (const text of [set.text, again.text, ...logged]) {
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain(recovery);
      }
      const rows = await auditOf(world.alpha, CHANGED);
      const mine = rows.filter((row) => row.actor_id === ivy.actorId);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.row).not.toContain(CANARY);
      expect(mine[0]?.row).not.toContain(recovery);
      const attempts = await attemptsOf(world.alpha, ivy.presented.subject);
      expect(attempts.map((one) => one.refusal_code)).toEqual(['AUTH_SESSION_EXPIRED']);
      for (const one of attempts) {
        expect(one.row).not.toContain(CANARY);
        expect(one.row).not.toContain(recovery);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

C40('C40 password reset, link use: isolation', () => {
  it('C40 isolation: a reset reaches only the person’s own login, in each business', async () => {
    const bravoActor = await inBravoToo(clientA.presented.subject, 'client-a-in-bravo');
    const subjectA = clientA.presented.subject;
    const subjectB = clientB.presented.subject;
    const { old: oldA, recovery } = await sessionsOf(subjectA);
    const oldB = await tokenFor(subjectB, randomUUID(), 'password', now() - 60);
    const bea = await tokenFor(world.bea.presented.subject, randomUUID(), 'password', now() - 60);
    const before = {
      alpha: (await auditOf(world.alpha, CHANGED)).length,
      bravo: (await auditOf(world.bravo, CHANGED)).length,
    };

    expect((await setPassword(recovery, NEW_PASSWORD)).status).toBe(200);

    expect(await doorAnswer(oldA, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(oldA, 'bravo')).toBe(ENDED);
    // The same business's other client, and another business's own person, are untouched.
    expect(await doorAnswer(oldB, 'alpha')).toBe('served');
    expect(await doorAnswer(bea, 'bravo')).toBe('served');
    const alpha = (await auditOf(world.alpha, CHANGED)).slice(before.alpha);
    const bravo = (await auditOf(world.bravo, CHANGED)).slice(before.bravo);
    expect(alpha.map((row) => row.actor_id)).toEqual([clientA.actorId]);
    expect(bravo.map((row) => row.actor_id)).toEqual([bravoActor]);
  });
});

C40('C40 password reset, link use: records', () => {
  it('C40 records: each password change is audited, applied, in each business the login reaches', async () => {
    const zoe = await freshMember('zoe');
    const bravoActor = await inBravoToo(zoe.presented.subject, 'zoe-in-bravo');
    const { recovery } = await sessionsOf(zoe.presented.subject);
    expect((await setPassword(recovery, NEW_PASSWORD)).status).toBe(200);
    const alpha = (await auditOf(world.alpha, CHANGED)).filter((r) => r.actor_id === zoe.actorId);
    const bravo = (await auditOf(world.bravo, CHANGED)).filter((r) => r.actor_id === bravoActor);
    for (const rows of [alpha, bravo]) {
      expect(rows.map((row) => [row.command, row.outcome])).toEqual([[CHANGED, 'applied']]);
      expect(rows[0]?.row).not.toContain(NEW_PASSWORD);
    }
  });
});
