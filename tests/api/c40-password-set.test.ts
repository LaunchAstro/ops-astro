// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, link use (ORCH77-C40B), through the real API, custody and a stand-in
// login provider: the reset link's one-time token sets the new password
// through custody's admin update, and every session of the login ends, in
// every business it reaches. The token is good for that and nothing else,
// and once.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { insertLogin } from '../identity/fixture.ts';
import { CANARY, HOSTILE, json } from './c58-sessions-world.ts';
import {
  answerWith,
  auditOf,
  clientA,
  clientB,
  doorAnswer,
  freshMember,
  inBravoToo,
  mintToken,
  now,
  seen,
  serviceKey,
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
const DONE = { passwordSet: true };

const answerOf = (answer: { status: number; body: Record<string, unknown> }) => ({
  status: answer.status,
  code: answer.body['code'],
});

/** A session signed in a minute ago. */
const oldSession = async (subject: string) => await tokenFor(subject, randomUUID(), now() - 60);

const C40 = describe.skipIf(serverUrl === undefined);

C40('C40 password reset, link use: sessions', () => {
  it('C40 other sessions end: the new password ends every session, in every business', async () => {
    const mia = await freshMember('mia');
    const subject = mia.presented.subject;
    await inBravoToo(subject, 'mia-in-bravo');
    const old = await oldSession(subject);
    expect(await doorAnswer(old, 'alpha')).toBe('served');
    expect(await doorAnswer(old, 'bravo')).toBe('served');

    const set = await setPassword(await mintToken(subject), NEW_PASSWORD);
    expect({ status: set.status, body: set.body }).toEqual({ status: 200, body: DONE });

    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    // At the provider: one admin update of this login, with custody's key and the password alone.
    expect(seen.map((one) => one.route)).toEqual([`PUT /auth/v1/admin/users/${subject}`]);
    expect(seen[0]?.authorization).toBe(`Bearer ${serviceKey}`);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ password: NEW_PASSWORD });
    // A sign-in with the new password, after the reset, is served.
    const after = await tokenFor(subject, randomUUID(), now() + 1);
    expect(await doorAnswer(after, 'alpha')).toBe('served');
  });
});

C40('C40 password reset, link use: the token', () => {
  it('C40 signed-out reset: a spent, expired, unknown or unmapped token sets nothing', async () => {
    const noah = await freshMember('noah');
    const subject = noah.presented.subject;
    const token = await mintToken(subject);
    expect((await setPassword(token, NEW_PASSWORD)).status).toBe(200);
    seen.length = 0;

    // The same token again: spent. A token past its 30 minutes, one never minted, one out of shape.
    expect(answerOf(await setPassword(token, 'another long password'))).toEqual(INVALID);
    expect(
      answerOf(await setPassword(await mintToken(subject, world.alpha, 31), NEW_PASSWORD)),
    ).toEqual(INVALID);
    const unknown = Buffer.alloc(32, 7).toString('base64url');
    expect(answerOf(await setPassword(unknown, NEW_PASSWORD))).toEqual(INVALID);
    expect(answerOf(await setPassword('not a token', NEW_PASSWORD))).toEqual(INVALID);
    // A token of a login no business maps to a person.
    const stranger = `stranger-${randomUUID()}`;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await insertLogin(tx, stranger);
    });
    expect(answerOf(await setPassword(await mintToken(stranger), NEW_PASSWORD))).toEqual(INVALID);
    // A password out of bounds, with a live token, which stays live.
    const next = await mintToken(subject);
    expect(answerOf(await setPassword(next, 'short'))).toEqual({
      status: 400,
      code: 'PASSWORD_INVALID',
    });
    expect(seen).toEqual([]);
    expect((await setPassword(next, NEW_PASSWORD)).status).toBe(200);
  });
});

C40('C40 password reset, link use: the provider', () => {
  it('C40 hostile provider: a wrong answer to the password update audits nothing', async () => {
    const bea = await freshMember('bea');
    const subject = bea.presented.subject;
    const hostile = {
      ...HOSTILE,
      'a 200 naming another user': json(200, { id: 'someone-else', msg: CANARY }),
      'a 200 with no user': json(200, { msg: CANARY }),
    };
    const old = await oldSession(subject);
    // One wrong answer at a time, each on a token of its own: a fault spends
    // the token it came on and ends the login's sessions, and the person asks again.
    for (const [name, reply] of Object.entries(hostile)) {
      answerWith(reply);
      seen.length = 0;
      // oxlint-disable-next-line no-await-in-loop
      const token = await mintToken(subject);
      // oxlint-disable-next-line no-await-in-loop
      const set = await setPassword(token, NEW_PASSWORD);
      expect(answerOf(set), name).toEqual({ status: 503, code: 'RESET_UNAVAILABLE' });
      expect(set.text, name).not.toContain(CANARY);
      expect(seen, name).toHaveLength(1);
      // oxlint-disable-next-line no-await-in-loop
      expect(answerOf(await setPassword(token, NEW_PASSWORD)), name).toEqual(INVALID);
    }
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    const audited = await auditOf(world.alpha, CHANGED);
    expect(audited.filter((row) => row.actor_id === bea.actorId)).toEqual([]);
  });
});

C40('C40 password reset, link use: secrets', () => {
  it('C40 token canary: the password and token reach no answer, audit row or log', async () => {
    const ivy = await freshMember('ivy');
    const password = `${CANARY}-password`;
    const token = await mintToken(ivy.presented.subject);
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    try {
      const set = await setPassword(token, password);
      expect(set.status).toBe(200);
      const again = await setPassword(token, password);
      for (const text of [set.text, again.text, ...logged]) {
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain(token);
      }
      const mine = (await auditOf(world.alpha, CHANGED)).filter(
        (row) => row.actor_id === ivy.actorId,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]?.row).not.toContain(CANARY);
      expect(mine[0]?.row).not.toContain(token);
      const kept = await world.db.app.withBusiness(
        world.alpha,
        async (tx) =>
          await tx.query<{ row: string }>(
            'select to_jsonb(t)::text as row from password_reset_tokens t',
          ),
      );
      expect(kept.map((one) => one.row).join()).not.toContain(token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

C40('C40 password reset, link use: isolation', () => {
  it('C40 isolation: a reset reaches only the person’s own login, in each business', async () => {
    await inBravoToo(clientA.presented.subject, 'client-a-in-bravo');
    const subjectA = clientA.presented.subject;
    const oldA = await oldSession(subjectA);
    const oldB = await oldSession(clientB.presented.subject);
    const bea = await oldSession(world.bea.presented.subject);
    const before = {
      alpha: (await auditOf(world.alpha, CHANGED)).length,
      bravo: (await auditOf(world.bravo, CHANGED)).length,
    };
    // Client B's token is minted, and never used: A's reset leaves it live.
    const tokenB = await mintToken(clientB.presented.subject);

    expect((await setPassword(await mintToken(subjectA), NEW_PASSWORD)).status).toBe(200);

    expect(await doorAnswer(oldA, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(oldA, 'bravo')).toBe(ENDED);
    // The same business's other client, and another business's own person, are untouched.
    expect(await doorAnswer(oldB, 'alpha')).toBe('served');
    expect(await doorAnswer(bea, 'bravo')).toBe('served');
    const alpha = (await auditOf(world.alpha, CHANGED)).slice(before.alpha);
    const bravo = (await auditOf(world.bravo, CHANGED)).slice(before.bravo);
    // One audit row, in the token's business; bravo keeps its ended sessions alone.
    expect(alpha.map((row) => [row.actor_id, row.outcome])).toEqual([[clientA.actorId, 'applied']]);
    expect(bravo).toEqual([]);
    for (const row of [...alpha, ...bravo]) expect(row.row).not.toContain(NEW_PASSWORD);
    // Client B's own token is still live.
    expect((await setPassword(tokenB, NEW_PASSWORD)).status).toBe(200);
  });
});
