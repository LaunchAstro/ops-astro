// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, the mail: the login provider's Send Email hook asks for a reset, and
// the reset link reaches the person through the broker's `email.send`, with
// its attempt (0225) and `account.password_reset_requested` in each business
// the login reaches; over C39-T's hook world (the fake email provider on
// loopback, custody holding the mail key, a verified sender).

import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mountAuthHook, postAuth, signAuth, tokenHash } from './c39-t-hook-world.ts';
import { noDatabase, useInvitationWorld, w } from './c39-t-world.ts';
import { digest, loginIn, mailsTo, recoveryFor, type Login } from './c40-reset-world.ts';

useInvitationWorld({ auth: true });

const C40 = describe.skipIf(noDatabase);
const REQUESTED = 'account.password_reset_requested';
const audited = async (business: string): Promise<readonly { actor_id: string; row: string }[]> =>
  await w.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ actor_id: string; row: string }>(
        `select actor_id, to_jsonb(a)::text as row from public.audit_events a
          where command = $1 order by seq`,
        [REQUESTED],
      ),
  );

const attempts = async (login: Login): Promise<readonly { state: string; row: string }[]> =>
  await w.db.admin.execute<{ state: string; row: string }>(
    `select state, to_jsonb(a)::text as row from ops.password_reset_attempts a
      where subject_digest = $1 order by recorded_at, state desc`,
    [digest(login.subject)],
  );

C40('C40 password reset, the mail', () => {
  it('C40 records: the reset link is mailed, its attempt and audits recorded in each business', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const login = await loginIn([w.alpha, w.bravo]);
    const hash = tokenHash();
    expect(await postAuth(recoveryFor(login, hash))).toEqual({ status: 200, text: '{}' });
    const [mail, ...more] = mailsTo(login.address);
    expect(more).toEqual([]);
    expect(mail).toContain(`https://ops.example.test/reset#token_hash=${hash}`);
    expect((await attempts(login)).map((one) => one.state)).toEqual(['asked', 'accepted']);
    for (const business of [w.alpha, w.bravo]) {
      // oxlint-disable-next-line no-await-in-loop
      const rows = (await audited(business)).filter(
        (one) => one.actor_id === login.actors[business],
      );
      expect(rows).toHaveLength(1);
    }
  });
});

C40('C40 password reset, the mail: isolation', () => {
  it('C40 isolation: a reset reaches only its own login’s records, business by business', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const login = await loginIn([w.alpha]);
    const neighbour = await loginIn([w.alpha, w.bravo]);
    const before = {
      alpha: (await audited(w.alpha)).length,
      bravo: (await audited(w.bravo)).length,
    };
    expect((await postAuth(recoveryFor(login))).status).toBe(200);
    const alpha = (await audited(w.alpha)).slice(before.alpha);
    const bravo = (await audited(w.bravo)).slice(before.bravo);
    expect(alpha.map((one) => one.actor_id)).toEqual([login.actors[w.alpha]]);
    expect(bravo).toEqual([]);
    expect(await attempts(neighbour)).toEqual([]);
    expect(mailsTo(neighbour.address)).toEqual([]);
    // A login no business maps gets no mail, answered the same.
    const stranger = { subject: randomUUID(), address: 'stranger@example.test', actors: {} };
    expect(await postAuth(recoveryFor(stranger))).toEqual({ status: 200, text: '{}' });
    expect(mailsTo(stranger.address)).toEqual([]);
  });
});

C40('C40 password reset, the mail: signed-out reset', () => {
  it('C40 signed-out reset: the limits per login and per address, and a replay sends nothing', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const login = await loginIn([w.alpha]);
    const first = recoveryFor(login);
    const signed = signAuth(first);
    expect((await postAuth(first, signed)).status).toBe(200);
    expect((await postAuth(first, signed)).status).toBe(409);
    for (let more = 0; more < 3; more += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      expect(await postAuth(recoveryFor(login))).toEqual({ status: 200, text: '{}' });
    }
    expect(mailsTo(login.address)).toHaveLength(3);
    // Another login under the same address is held by the address's count.
    const twin = await loginIn([w.alpha], login.address);
    expect(await postAuth(recoveryFor(twin))).toEqual({ status: 200, text: '{}' });
    expect(mailsTo(login.address)).toHaveLength(3);
    expect(await attempts(twin)).toEqual([]);
  });
});

C40('C40 password reset, the mail: token canary', () => {
  it('C40 token canary: the hashed token and the code reach the mail link alone', async () => {
    mountAuthHook();
    const login = await loginIn([w.alpha, w.bravo]);
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    const planted: string[] = [];
    const answers: string[] = [];
    try {
      for (const mode of ['accept', 'refuse', 'malformed'] as const) {
        w.provider.mode(mode);
        const hash = tokenHash();
        const otp = `otp-${randomBytes(6).toString('hex')}`;
        planted.push(hash, otp);
        // oxlint-disable-next-line no-await-in-loop
        answers.push((await postAuth(recoveryFor(login, hash, otp))).text);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      w.provider.mode('accept');
    }
    const stored = [
      ...(await attempts(login)).map((one) => one.row),
      ...(await audited(w.alpha)).map((one) => one.row),
      ...(await audited(w.bravo)).map((one) => one.row),
    ];
    const haystack = [...answers, ...logged, ...stored, w.custody.stderr()].join('\n');
    for (const secret of planted) expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain(login.address);
    // The mails carry each hashed token once, in the link's fragment, and never the code.
    const mails = mailsTo(login.address).join('\n');
    expect(mails).not.toMatch(/otp-/u);
    expect(mails).toContain(`#token_hash=${planted[0] ?? ''}`);
    expect((await attempts(login)).map((one) => one.state)).toEqual([
      'asked',
      'accepted',
      'asked',
      'failed',
      'asked',
      'failed',
    ]);
  });
});
