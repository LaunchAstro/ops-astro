// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: the invitation's link is ours. Every send mints its own token and
// keeps only its SHA-256; the login provider is never asked for a link, so a
// hostile one (refused, oversized, redirected, malformed, slow) changes
// nothing, and an address that already holds a login in another business is
// invited exactly like a new one. Nothing the provider hands over (a hashed
// token, a one-time code) is kept or derived from at rest, and a planted
// invitation or reset token never reaches a log, an error, a trace, an answer
// or a stored row, on the send path or the hook's.

import { createHash, randomInt } from 'node:crypto';
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
  as,
  auth,
  c,
  codeOf,
  countFor,
  invite,
  linkIn,
  MAIL,
  noDatabase,
  storedText,
  useInvitationWorld,
  w,
  send,
} from './c39-t-world.ts';

useInvitationWorld({ auth: true });

/** Every answer the login provider can give; none of them is ever asked for. */
const PROVIDER_MODES: readonly FakeAuthMode[] = [
  'accept',
  'exists',
  'oversized',
  'redirect',
  'not_json',
  'bad_token',
  'other_type',
  'no_token',
  'slow',
];

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** GoTrue's hashed token: hex SHA-224 of the address and the one-time code. */
const providerHash = (email: string, otp: string): string =>
  createHash('sha224')
    .update(email + otp)
    .digest('hex');

/** A send's answer with its attempt's id masked, so two answers compare by shape. */
const shape = (result: object): string =>
  JSON.stringify(result, (key, value: unknown) => (key === 'attemptId' ? 'id' : value));

/** The rows of the three invitation tables, as text. */
async function invitationRows(): Promise<string> {
  const parts = await Promise.all(
    ['invitations', 'enrolment_tokens', 'invitation_delivery_attempts'].map(
      async (table) =>
        await w.db.admin.execute<{ t: string }>(
          `select coalesce(string_agg(to_jsonb(x)::text, ' '), '') as t from public.${table} x`,
        ),
    ),
  );
  return parts.map((rows) => rows[0]?.t ?? '').join(' ');
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invite link', () => {
  it('C39-T hostile provider: the send never asks the login provider, so a refused, oversized, redirected, malformed or slow one changes nothing', async () => {
    w.provider.mode('accept');
    const asked = auth.fake.received.length;
    for (const mode of PROVIDER_MODES) {
      auth.fake.mode(mode);
      const address = addressFor(mode);
      // oxlint-disable-next-line no-await-in-loop
      const id = await invite(c.admin, address);
      // oxlint-disable-next-line no-await-in-loop
      expect(await send(id), mode).toMatchObject({ ok: true, state: 'accepted' });
      expect(mailTo(address), mode).toHaveLength(1);
      // oxlint-disable-next-line no-await-in-loop
      expect(await countFor('enrolment_tokens', id), mode).toBe(1);
      // Our own token: 32 random bytes, kept as its SHA-256 alone.
      const { token } = linkIn(mailTo(address)[0]);
      expect(token, mode).toMatch(/^[\w-]{43}$/u);
      // oxlint-disable-next-line no-await-in-loop
      const [kept] = await w.db.admin.execute<{ token_hash: string }>(
        'select token_hash from public.enrolment_tokens where invitation_id = $1',
        [id],
      );
      expect(kept?.token_hash, mode).toBe(sha256(token));
    }
    auth.fake.mode('accept');
    expect(auth.fake.received).toHaveLength(asked);
    expect(JSON.stringify(w.broker.routes)).not.toContain(auth.key);
    expect(JSON.stringify(process.env)).not.toContain(auth.key);
  }, 60_000);

  it('C39-T token canary: no column of an invitation, its token or its attempts holds anything derived from a provider value', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const address = addressFor('provider-values');
    const id = await invite(c.admin, address);
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const fresh = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const hashed = providerHash(address, otp);
    const hashedNew = providerHash(address, fresh);
    const hashes = [hashed, hashedNew];
    const raw = authMessage('invite', address, hashed, {
      token: otp,
      token_new: fresh,
      token_hash_new: hashedNew,
    });
    expect(await postAuth(raw)).toStrictEqual({ status: 200, text: '{}' });
    expect(mailTo(address)).toHaveLength(1);
    expect(await countFor('enrolment_tokens', id)).toBe(1);
    // A six-digit code alone could match any number at rest, so only its hash is looked for.
    const derived = [...hashes, ...[...hashes, otp, fresh].map((value) => sha256(value))];
    const rows = await invitationRows();
    for (const value of derived) {
      expect(rows.includes(value), 'a provider value, or its hash, at rest').toBe(false);
    }
    // The link carries our token, never the provider's.
    const { token } = linkIn(mailTo(address)[0]);
    for (const value of hashes) expect(token).not.toBe(value);
  });

  // eslint-disable-next-line max-lines-per-function -- the enrolled address, its control, and the hook for both
  it('C39-T no account oracle: an address holding a login in another business is invited and answered exactly like a new one', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    // The address enrolled in bravo: its invitation there accepted, a confirmed user at the provider.
    const enrolled = addressFor('enrolled-in-bravo');
    const bravoId = await invite(c.bravoAdmin, enrolled);
    await w.db.admin.execute(
      `update public.invitations set state = 'accepted', ended_at = now() where id = $1`,
      [bravoId],
    );
    auth.fake.mode('exists');
    const asked = auth.fake.received.length;
    const fresh = addressFor('never-enrolled');
    const enrolledId = await invite(c.admin, enrolled);
    const freshId = await invite(c.admin, fresh);
    const sentEnrolled = await send(enrolledId);
    const sentFresh = await send(freshId);
    expect(sentEnrolled).toMatchObject({ ok: true, state: 'accepted' });
    expect(shape(sentEnrolled)).toBe(shape(sentFresh));
    expect(mailTo(enrolled)).toHaveLength(1);
    expect(mailTo(fresh)).toHaveLength(1);
    // Through the hook: a resend act each, then a message each; and one with no act left.
    for (const id of [enrolledId, freshId]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    }
    const answers = [
      await postAuth(authMessage('invite', enrolled)),
      await postAuth(authMessage('invite', fresh)),
      await postAuth(authMessage('invite', enrolled)),
      await postAuth(authMessage('recovery', enrolled)),
    ];
    expect(new Set(answers.map((answer) => `${String(answer.status)} ${answer.text}`))).toEqual(
      new Set(['200 {}']),
    );
    expect(mailTo(enrolled)).toHaveLength(2);
    expect(mailTo(fresh)).toHaveLength(2);
    // Bravo's accepted invitation is untouched, and the provider was never asked.
    expect(await countFor('enrolment_tokens', bravoId)).toBe(0);
    expect(await countFor('enrolment_tokens', enrolledId)).toBe(2);
    expect(auth.fake.received).toHaveLength(asked);
    auth.fake.mode('accept');
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
    const mailed: string[] = [];
    const providerTokens: string[] = [];
    try {
      auth.fake.mode('accept');
      w.provider.mode('accept');
      // The send path, and a send that fails after the link was made.
      const sentTo = addressFor('canary-sent');
      answers.push(JSON.stringify(await send(await invite(c.admin, sentTo))));
      mailed.push(sentTo);
      w.provider.mode('slow');
      const slowTo = addressFor('canary-slow');
      answers.push(JSON.stringify(await send(await invite(c.admin, slowTo))));
      mailed.push(slowTo);
      w.provider.mode('accept');
      // The hook path: an invitation sent, and every other Auth message with planted tokens.
      mountAuthHook();
      const hooked = addressFor('canary-hook');
      await invite(c.admin, hooked);
      mailed.push(hooked);
      const hookToken = tokenHash();
      providerTokens.push(hookToken);
      answers.push((await postAuth(authMessage('invite', hooked, hookToken))).text);
      for (const action of ['recovery', 'magiclink', 'email_change', 'reauthentication']) {
        const hash = tokenHash();
        const otp = `${action}-otp-${tokenHash().slice(0, 12)}`;
        const fresh = tokenHash();
        providerTokens.push(hash, otp, fresh);
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
      providerTokens.push(planted);
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
    for (const address of mailed) {
      const { token } = linkIn(mailTo(address)[0]);
      expect(token, 'an invitation email without its token').toMatch(/^[\w-]{43}$/u);
      expect(haystack.includes(token), 'an invitation token outside its email').toBe(false);
    }
    for (const token of providerTokens) {
      expect(haystack.includes(token), 'a reset or provider token kept').toBe(false);
      expect(outbox.includes(token), 'a provider token mailed').toBe(false);
    }
    expect(haystack.includes(auth.key)).toBe(false);
  }, 60_000);
});
