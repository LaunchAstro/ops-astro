// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's send and the provider's message id. The email adapter
// admits ids of up to 64 characters of [A-Za-z0-9-], so a provider whose ids
// run 43 characters or more (an SES-style id is about 60) still records the
// invitation as sent. An enrolment token is just as long and just as spelt,
// so such an id is kept as its SHA-256, which still names the message, and
// one that holds this send's own token never stores it.

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sendInvitation, type Custody } from '../../packages/core-custody/src/index.ts';
import {
  c,
  invite,
  linkIn,
  MAIL,
  noDatabase,
  received,
  storedText,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

// Tokens with no `_`, so every one is also a valid message id.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const noUnderscore = (size: number): Buffer =>
    Buffer.from(real.randomBytes(size).toString('base64url').replaceAll('_', 'A'), 'base64url');
  return { ...real, randomBytes: noUnderscore };
});

useInvitationWorld();

/** Custody whose provider answers, once it has sent, with the id `idFor` makes of the request. */
function answeringWith(idFor: (body: string) => string): Custody {
  return {
    ...w.custody,
    dispatch: async (ref, request) => {
      const outcome = await w.custody.dispatch(ref, request);
      if (outcome.kind !== 'answered') return outcome;
      const id = idFor(request.body);
      return { ...outcome, outbound: { ok: true, status: 200, body: JSON.stringify({ id }) } };
    },
  };
}

/** What the send recorded for one invitation, oldest first. */
async function attemptsFor(
  invitationId: string,
): Promise<readonly { state: string; evidence: string | null }[]> {
  return await w.db.admin.execute<{ state: string; evidence: string | null }>(
    `select state, evidence from public.invitation_delivery_attempts
      where invitation_id = $1 order by observed_seq`,
    [invitationId],
  );
}

const idOf = (length: number): string =>
  randomBytes(48).toString('base64url').replaceAll('_', '-').slice(0, length);

describe.skipIf(noDatabase)('an invitation sent under a long provider message id', () => {
  it.each([43, 60, 64])(
    'a provider message id of %i characters records the invitation as sent',
    async (length) => {
      const id = await invite(c.admin);
      const before = received();
      const messageId = idOf(length);
      const custody = answeringWith(() => messageId);
      const result = await sendInvitation(w.db.app, w.alpha, id, { ...w.broker, custody }, MAIL);
      expect(result).toStrictEqual({ ok: true, attemptId: expect.any(String), state: 'accepted' });
      expect(received()).toBe(before + 1);
      const digest = createHash('sha256').update(messageId).digest('hex');
      expect(await attemptsFor(id)).toEqual([
        { state: 'asked', evidence: null },
        { state: 'accepted', evidence: `provider:sha256:${digest}` },
      ]);
    },
  );

  it('a 64-character message id that ends with the link token keeps that token out of the database', async () => {
    const id = await invite(c.admin);
    const custody = answeringWith((body) => `${idOf(21)}${linkIn(body).token}`);
    await sendInvitation(w.db.app, w.alpha, id, { ...w.broker, custody }, MAIL);
    const token = linkIn(w.provider.outbox.at(-1)?.body).token;
    expect(/^[A-Za-z0-9-]{43}$/u.test(token)).toBe(true);
    expect((await storedText()).includes(token), 'enrolment token stored as evidence').toBe(false);
  });
});
