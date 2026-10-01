// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P2: the login provider's Send Email hook, through the real
// route over a migrated database, custody's real process and the fake email
// provider. The route lets a message in only on a Standard Webhooks signature
// over its raw bytes, checked before a byte is parsed; refuses a stale
// timestamp and a replayed message id, durably; answers every verified
// message alike, sent or not, so it never says whether an account exists;
// and hands an Auth invitation to the broker's `email.send` with its attempt and
// our own token, only for a person's recorded act, in the one business, for
// the one person. The provider's token hash is never used.

import { describe, expect, it } from 'vitest';
import { authEmailHookSettings } from '../../apps/api/auth-email-hook.ts';
import {
  ah,
  AUTH_HOOK_SECRET,
  attemptRows,
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
  c,
  codeOf,
  countFor,
  invite,
  linkIn,
  MAIL,
  noDatabase,
  received,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld({ auth: true });

const SVIX = ['svix-id', 'svix-timestamp', 'svix-signature'] as const;
const otherSecret = (): string => `v1,whsec_${Buffer.alloc(24, 7).toString('base64')}`;

/** Tokens and attempts in every business for one invitation, as a pair. */
const recorded = async (id: string): Promise<[number, number]> => [
  await countFor('enrolment_tokens', id),
  await countFor('invitation_delivery_attempts', id),
];

describe('C39-T hook settings', () => {
  it('C39-T hook signature: the secret is read in the login provider form only, and a wrong one names the setting, never its value', () => {
    expect(authEmailHookSettings({})).toStrictEqual({ kind: 'absent' });
    expect(authEmailHookSettings({ AUTH_EMAIL_HOOK_SECRET: AUTH_HOOK_SECRET })).toStrictEqual({
      kind: 'configured',
      secret: AUTH_HOOK_SECRET.slice('v1,'.length),
    });
    for (const wrong of [AUTH_HOOK_SECRET.slice(3), 'v1,whsec_short', 'v2,whsec_x', 'plain']) {
      const read = authEmailHookSettings({ AUTH_EMAIL_HOOK_SECRET: wrong });
      expect(read.kind, wrong).toBe('invalid');
      expect(JSON.stringify(read)).not.toContain(wrong);
    }
  });
});

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T Auth email hook', () => {
  it('C39-T hook signature: only a Standard Webhooks signature over the raw body lets a message in, and nothing is parsed or sent before it', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const address = addressFor('hooked');
    const id = await invite(c.admin, address);
    const hash = tokenHash();
    const raw = authMessage('invite', address, hash);
    const before = received();
    const refusals = [
      // No headers at all, and the provider's other header names (Svix's).
      { body: raw, signed: null, names: undefined },
      { body: raw, signed: signAuth(raw), names: SVIX },
      // Altered after signing, re-encoded, or signed under another secret.
      { body: raw.replace('invite', 'invitf'), signed: signAuth(raw), names: undefined },
      { body: JSON.stringify(JSON.parse(raw), null, 1), signed: signAuth(raw), names: undefined },
      { body: raw, signed: signAuth(raw, ah.clock, undefined, otherSecret()), names: undefined },
      // Not JSON at all, unsigned for it: refused for the signature, never read as malformed.
      { body: '{not json', signed: signAuth(raw), names: undefined },
    ];
    for (const [n, refusal] of refusals.entries()) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await postAuth(refusal.body, refusal.signed, refusal.names);
      expect(answer.status, String(n)).toBe(401);
      expect(answer.text, String(n)).toMatch(/^\{"code":"HOOK_(HEADERS|SIGNATURE)"\}$/u);
    }
    expect(received()).toBe(before);
    expect(await recorded(id)).toEqual([0, 0]);
    // Signed and well formed, but not the provider's shape: refused once verified.
    const odd = JSON.stringify({ user: { email: address }, email_data: { token_hash: hash } });
    expect(await postAuth(odd)).toStrictEqual({ status: 400, text: '{"code":"HOOK_MALFORMED"}' });
    // The real message: one email to the invited address, its link our own token, never the hook's.
    const signed = signAuth(raw);
    expect(await postAuth(raw, signed)).toStrictEqual({ status: 200, text: '{}' });
    const mail = mailTo(address);
    expect(mail).toHaveLength(1);
    expect(linkIn(mail[0]).token).toMatch(/^[\w-]{43}$/u);
    expect(mail[0]).not.toContain(hash);
    expect(await attemptRows(id)).toEqual([
      { state: 'asked', evidence: `hook:${signed.id}` },
      { state: 'accepted', evidence: expect.stringMatching(/^provider:/u) as unknown },
    ]);
    expect(received()).toBe(before + 1);
  });

  it('C39-T hook signature: a stale or future timestamp and a replayed message id are refused, two at once and on a fresh route included', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const address = addressFor('replayed');
    const id = await invite(c.admin, address);
    const raw = authMessage('invite', address);
    for (const at of [ah.clock - 301, ah.clock + 301, 0]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await postAuth(raw, signAuth(raw, at)), String(at)).toStrictEqual({
        status: 401,
        text: '{"code":"HOOK_STALE"}',
      });
    }
    expect(await recorded(id)).toEqual([0, 0]);
    // A second act, so a replay is refused for being one, not for want of an act.
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    const signed = signAuth(raw, ah.clock - 299);
    const both = await Promise.all([postAuth(raw, signed), postAuth(raw, signed)]);
    expect(both.map((answer) => answer.status).toSorted()).toEqual([200, 409]);
    expect(await recorded(id)).toEqual([1, 2]);
    // On a fresh route, as another process would serve it: the id is held in the database.
    mountAuthHook();
    expect(await postAuth(raw, signed)).toStrictEqual({ status: 409, text: '{"code":"REPLAYED"}' });
    expect(mailTo(address)).toHaveLength(1);
    expect(await recorded(id)).toEqual([1, 2]);
  });

  it('C39-T no account oracle: every verified message is answered alike, whether anyone has an account, an invitation or a send', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    const pending = addressFor('pending');
    await invite(c.admin, pending);
    const answered = addressFor('answered');
    expect(await send(await invite(c.admin, answered))).toMatchObject({ ok: true });
    const failing = addressFor('failing');
    await invite(c.admin, failing);
    const before = received();
    const messages = [
      authMessage('invite', pending),
      authMessage('invite', addressFor('nobody')),
      authMessage('invite', answered),
      authMessage('recovery', w.canary),
      authMessage('recovery', addressFor('nobody')),
      authMessage('magiclink', w.canary),
      authMessage('email_change', w.canary, tokenHash(), { token_hash_new: tokenHash() }),
      authMessage('signup', addressFor('nobody')),
      authMessage('reauthentication', w.canary),
    ];
    const answers = [];
    for (const raw of messages) {
      // oxlint-disable-next-line no-await-in-loop
      answers.push(await postAuth(raw));
    }
    // A send the provider refuses is answered the same.
    w.provider.mode('refuse');
    answers.push(await postAuth(authMessage('invite', failing)));
    w.provider.mode('accept');
    expect(new Set(answers.map((answer) => `${String(answer.status)} ${answer.text}`))).toEqual(
      new Set(['200 {}']),
    );
    // Only the pending invitation's act was sent, and the refused send was asked once.
    expect(mailTo(pending)).toHaveLength(1);
    expect(received()).toBe(before + 2);
  });

  // eslint-disable-next-line max-lines-per-function -- each crossing, then its control
  it('C39-T isolation: the hook sends for the one business, the one person and never for a client-scoped act', async () => {
    mountAuthHook();
    w.provider.mode('accept');
    // Business: an address pending in bravo alone lands in bravo; alpha holds nothing of it.
    const inBravo = addressFor('bravo-only');
    const bravoId = await invite(c.bravoAdmin, inBravo);
    expect(await postAuth(authMessage('invite', inBravo))).toMatchObject({ status: 200 });
    expect(await recorded(bravoId)).toEqual([1, 2]);
    const [alphaRows] = await w.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.invitations where business_id = $1 and address = $2`,
      [w.alpha, inBravo],
    );
    expect(alphaRows?.n).toBe('0');
    // Business, the other way: pending in both, the message cannot say whose; nothing is sent.
    const shared = addressFor('both');
    const sharedAlpha = await invite(c.admin, shared);
    const sharedBravo = await invite(c.bravoAdmin, shared);
    expect(await postAuth(authMessage('invite', shared))).toMatchObject({ status: 200 });
    expect(await recorded(sharedAlpha)).toEqual([0, 0]);
    expect(await recorded(sharedBravo)).toEqual([0, 0]);
    expect(mailTo(shared)).toHaveLength(0);
    // And a route serving alpha alone never reaches bravo's invitation.
    const bravoAgain = await invite(c.bravoAdmin, addressFor('bravo-again'));
    const alphaOnly = mountAuthHook([w.alpha]);
    const [bravoAddress] = await w.db.admin.execute<{ address: string }>(
      'select address from public.invitations where id = $1',
      [bravoAgain],
    );
    const bravoRaw = authMessage('invite', String(bravoAddress?.address));
    expect(await postAuth(bravoRaw, undefined, undefined, alphaOnly)).toMatchObject({
      status: 200,
    });
    expect(await recorded(bravoAgain)).toEqual([0, 0]);
    // Client: a person holding access:share on one client makes no act, so the hook sends nothing.
    const clientAddress = addressFor('client');
    const tried = await as(c.clientSharer, 'invitation.create', {
      name: 'Cy Client',
      email: clientAddress,
      role: 'member',
    });
    expect(codeOf(tried)).toBe('SCOPE_NOT_GRANTED');
    expect(await postAuth(authMessage('invite', clientAddress))).toMatchObject({ status: 200 });
    expect(mailTo(clientAddress)).toHaveLength(0);
    // Person: two people invited in alpha; the message for one touches only theirs.
    const first = addressFor('first');
    const second = addressFor('second');
    const firstId = await invite(c.admin, first);
    const secondId = await invite(c.admin, second);
    expect(await postAuth(authMessage('invite', first))).toMatchObject({ status: 200 });
    expect(await recorded(firstId)).toEqual([1, 2]);
    expect(await recorded(secondId)).toEqual([0, 0]);
    expect(mailTo(first)).toHaveLength(1);
    expect(mailTo(second)).toHaveLength(0);
    // The second person's own act is still unanswered, and its send is theirs.
    expect(await send(secondId)).toMatchObject({ ok: true });
    expect(MAIL.appOrigin).toBe('https://ops.example.test');
  });
});
