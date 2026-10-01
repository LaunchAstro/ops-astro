// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P2: the invitation's link is the login provider's invite
// link, generated server-side through custody under the catalogued
// `auth.invite_link`, so the service key never leaves custody's process.
// A hostile answer from the provider (refused, oversized, redirected,
// malformed, slow) sends nothing and keeps nothing, and the act stays
// unanswered for a later send. A planted invitation or reset token never
// reaches a log, an error, a trace, an answer or a stored row, on the send
// path or the hook's.

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_EMAIL_HOOK_PATH, mountAuthEmailHook } from '../../apps/api/auth-email-hook.ts';
import type { FakeAuthMode } from './c39-t-auth-fake.ts';
import {
  ah,
  AUTH_HOOK_SECRET,
  authMessage,
  mailTo,
  mountAuthHook,
  postAuth,
  signAuth,
  tokenHash,
} from './c39-t-hook-world.ts';
import {
  addressFor,
  auth,
  c,
  countFor,
  invite,
  linkIn,
  MAIL,
  noDatabase,
  received,
  send,
  storedText,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld({ auth: true });

const HOSTILE: readonly FakeAuthMode[] = [
  'exists',
  'oversized',
  'redirect',
  'not_json',
  'bad_token',
  'other_type',
  'no_token',
  'slow',
];

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invite link', () => {
  it('C39-T hostile provider: a refused, oversized, redirected, malformed or slow login provider sends nothing and keeps nothing', async () => {
    w.provider.mode('accept');
    for (const mode of HOSTILE) {
      auth.fake.mode(mode);
      // oxlint-disable-next-line no-await-in-loop
      const id = await invite(c.admin, addressFor(mode));
      const before = received();
      // oxlint-disable-next-line no-await-in-loop
      const sent = await send(id);
      expect(sent, mode).toMatchObject({ ok: false, code: 'AUTH_LINK_FAILED' });
      expect(received(), mode).toBe(before);
      // oxlint-disable-next-line no-await-in-loop
      expect(await countFor('enrolment_tokens', id), mode).toBe(0);
      // oxlint-disable-next-line no-await-in-loop
      expect(await countFor('invitation_delivery_attempts', id), mode).toBe(0);
      // The act is unanswered still: once the provider answers well, it sends once.
      auth.fake.mode('accept');
      // oxlint-disable-next-line no-await-in-loop
      expect(await send(id), mode).toMatchObject({ ok: true, state: 'accepted' });
    }
  }, 60_000);

  it('C39-T hostile provider: the provider is asked for an invite link to the one address, carried by the key custody holds', async () => {
    auth.fake.mode('accept');
    w.provider.mode('accept');
    const address = addressFor('asked');
    const asked = auth.fake.received.length;
    expect(await send(await invite(c.admin, address))).toMatchObject({ ok: true });
    const request = auth.fake.received.at(asked);
    expect(request?.path).toBe('/auth/v1/admin/generate_link');
    expect(request?.authorization).toBe(`Bearer ${auth.key}`);
    expect(JSON.parse(request?.body ?? '{}')).toStrictEqual({ type: 'invite', email: address });
    // The link carries the provider's hashed token, and the key is nowhere but custody.
    expect(linkIn(mailTo(address)[0]).token).toBe(auth.fake.issued.at(-1)?.hashed);
    expect(JSON.stringify(w.broker.routes)).not.toContain(auth.key);
    expect(JSON.stringify(process.env)).not.toContain(auth.key);
  });

  // eslint-disable-next-line max-lines-per-function -- one capture around every path a token could leak by
  it('C39-T token canary: a planted invitation or reset token never reaches logs, errors, traces, answers or the audit payload', async () => {
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
        vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(' '));
        }),
      ),
    ];
    const answers: string[] = [];
    const invitationTokens: string[] = [];
    const resetTokens: string[] = [];
    const oneTime: string[] = [];
    try {
      auth.fake.mode('accept');
      w.provider.mode('accept');
      // The send path: the provider's token and one-time code.
      const sentTo = addressFor('canary-sent');
      answers.push(JSON.stringify(await send(await invite(c.admin, sentTo))));
      const issued = auth.fake.issued.at(-1);
      invitationTokens.push(String(issued?.hashed));
      const oneTimeCode = String(issued?.otp);
      resetTokens.push(oneTimeCode);
      oneTime.push(oneTimeCode);
      // A send that fails after the link was made.
      w.provider.mode('slow');
      answers.push(JSON.stringify(await send(await invite(c.admin, addressFor('canary-slow')))));
      w.provider.mode('accept');
      invitationTokens.push(String(auth.fake.issued.at(-1)?.hashed));
      // The hook path: an invitation sent, and every other Auth message with planted tokens.
      mountAuthHook();
      const hooked = addressFor('canary-hook');
      await invite(c.admin, hooked);
      const hookToken = tokenHash();
      invitationTokens.push(hookToken);
      answers.push((await postAuth(authMessage('invite', hooked, hookToken))).text);
      for (const action of ['recovery', 'magiclink', 'email_change', 'reauthentication']) {
        const hash = tokenHash();
        const otp = `${action}-otp-${tokenHash().slice(0, 12)}`;
        const fresh = tokenHash();
        resetTokens.push(hash, otp, fresh);
        const raw = authMessage(action, w.canary, hash, { token: otp, token_hash_new: fresh });
        // oxlint-disable-next-line no-await-in-loop
        answers.push((await postAuth(raw)).text);
      }
      // The fault path: a deployment list the database refuses.
      const faulty = new Hono();
      mountAuthEmailHook(faulty, w.db.app, {
        secret: AUTH_HOOK_SECRET.slice(3),
        businesses: async () => await Promise.resolve(['not-a-business-id']),
        broker: w.broker,
        mail: MAIL,
        now: () => ah.clock * 1000,
      });
      const planted = tokenHash();
      resetTokens.push(planted);
      const raw = authMessage('recovery', w.canary, planted);
      const fault = await postAuth(raw, signAuth(raw), undefined, faulty);
      answers.push(`${String(fault.status)} ${fault.text}`);
      expect(fault.status).toBe(503);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const outbox = w.provider.received.map((message) => message.body).join(' ');
    const haystack = [
      ...written,
      ...answers,
      await storedText(),
      w.custody.stderr(),
      AUTH_EMAIL_HOOK_PATH,
    ].join('\n');
    for (const token of invitationTokens) {
      expect(haystack.includes(token), 'an invitation token outside its email').toBe(false);
      expect(outbox.includes(token), 'an invitation token missing from its email').toBe(true);
    }
    for (const token of resetTokens) {
      expect(haystack.includes(token), 'a reset or one-time token kept').toBe(false);
    }
    // The provider's one-time code is never part of the invitation email either.
    for (const code of oneTime) expect(outbox.includes(code)).toBe(false);
    expect(haystack.includes(auth.key)).toBe(false);
  }, 60_000);
});
