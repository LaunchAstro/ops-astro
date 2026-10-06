// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import {
  c,
  invite,
  linkIn,
  MAIL,
  noDatabase,
  send,
  storedText,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = (size: number): Buffer =>
    Buffer.from(real.randomBytes(size).toString('base64url').replaceAll('_', 'A'), 'base64url');
  return { ...real, randomBytes };
});

useInvitationWorld();

describe.skipIf(noDatabase)('C39-T token kept as a hash only, across sends', () => {
  it('an earlier enrolment token cannot be retained as provider evidence on a later send', async () => {
    const first = await invite(c.admin);
    expect(await send(first)).toMatchObject({ ok: true });
    const canary = linkIn(w.provider.outbox.at(-1)?.body).token;
    expect(/^[A-Za-z0-9-]{43}$/u.test(canary)).toBe(true);
    const custody: typeof w.custody = {
      ...w.custody,
      dispatch: async (ref, request) => {
        const outcome = await w.custody.dispatch(ref, request);
        if (outcome.kind !== 'answered') return outcome;
        return {
          ...outcome,
          outbound: { ok: true, status: 200, body: JSON.stringify({ id: canary }) },
        };
      },
    };
    const next = await invite(c.admin);
    await sendInvitation(w.db.app, w.alpha, next, { ...w.broker, custody }, MAIL);
    expect(
      (await storedText()).includes(canary),
      'prior enrolment token retained in database evidence',
    ).toBe(false);
  });
});
