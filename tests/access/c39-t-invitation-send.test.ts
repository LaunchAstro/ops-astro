// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P1: the invitation's send keeps AW-07b's rules for every
// broker email. It leaves only from the installation's verified sending
// subdomain, and what the provider answers is never a place the link's token
// is kept: an answer that carries it is read as malformed, and nothing stored
// holds it. The send's acts and records are `c39-t-invitations.test.ts`.

import { describe, expect, it, vi } from 'vitest';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import {
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

// Every link token this file mints is one the answer schema admits as a message
// id ([A-Za-z0-9-]{1,64}): each `_` in the bytes' base64url becomes `A`. Still
// random, so the token case's echo is certain in one send rather than likely
// in twelve.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = (size: number): Buffer =>
    Buffer.from(real.randomBytes(size).toString('base64url').replaceAll('_', 'A'), 'base64url');
  return { ...real, randomBytes };
});

useInvitationWorld();

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invitation send', () => {
  it('C39-T sender: an invitation from outside the verified sending subdomain, or before it verified, sends nothing and mints no token', async () => {
    w.provider.mode('accept');
    const id = await invite(c.admin);
    const unverified = { ...MAIL.sender, verified: false };
    for (const mail of [
      { ...MAIL, from: 'hello@example.com' },
      { ...MAIL, from: 'hello@example.test' },
      { ...MAIL, sender: unverified },
    ]) {
      const before = received();
      // oxlint-disable-next-line no-await-in-loop
      const sent = await sendInvitation(w.db.app, w.alpha, id, w.broker, mail);
      expect(sent, mail.from).toStrictEqual({ ok: false, code: 'SENDER_NOT_VERIFIED' });
      expect(received(), mail.from).toBe(before);
    }
    expect(await countFor('enrolment_tokens', id)).toBe(0);
    expect(await countFor('invitation_delivery_attempts', id)).toBe(0);
    // The act is still unanswered: from the verified sender, it sends once.
    expect(await send(id)).toMatchObject({ ok: true, state: 'accepted' });
  });

  it('C39-T token kept as a hash only: a provider answer that echoes the link token is never stored', async () => {
    w.provider.mode('accept');
    // A hostile provider: it takes the message, then answers with the link's token as its id.
    let echoed = '';
    const real = w.broker.custody;
    const custody: typeof real = {
      ...real,
      dispatch: async (ref, request) => {
        const outcome = await real.dispatch(ref, request);
        const { token } = linkIn(request.body);
        if (outcome.kind !== 'answered' || !/^[A-Za-z0-9-]{1,64}$/u.test(token)) return outcome;
        echoed = token;
        const body = JSON.stringify({ id: token });
        return { ...outcome, outbound: { ok: true, status: 200, body } };
      },
    };
    const id = await invite(c.admin);
    const sent = await sendInvitation(w.db.app, w.alpha, id, { ...w.broker, custody }, MAIL);
    expect(echoed, 'the answer echoed the link token').not.toBe('');
    expect(sent).toMatchObject({ ok: false, code: 'EMAIL_FAILED' });
    expect((await storedText()).includes(echoed)).toBe(false);
  });
});
