// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus interim review of C39-T P2 (SL12-18 REV3): the invite link and the
// Auth email hook, against what the login provider really answers.
//
// 1. Supabase Auth's hashed token is not a random secret: GoTrue makes it as
//    hex SHA-224 of the address and the one-time code (`GenerateTokenHash`,
//    `sha256.Sum224([]byte(email + otp))`), and the code is six digits by
//    default (ten at most). The send now keeps SHA-256 of that token, beside
//    the invitation's address, so anyone who reads the database rebuilds a
//    live enrolment link in at most a million guesses. 0222 promises nothing
//    is kept from which the token could be rebuilt.
// 2. GoTrue refuses an invite link for an address whose user is confirmed
//    (422 `email_exists`). The same provider subject may hold a login in two
//    businesses (0002, `logins_subject_idx`), so a person who enrolled in one
//    business can never be invited into another: every send is refused.

import { createHash, randomInt } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { authMessage, mailTo, mountAuthHook, postAuth } from './c39-t-hook-world.ts';
import {
  addressFor,
  auth,
  c,
  invite,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useInvitationWorld({ auth: true });

/** GoTrue's token hash: hex SHA-224 of the address and the one-time code. */
const providerHash = (email: string, otp: string): string =>
  createHash('sha224')
    .update(email + otp)
    .digest('hex');

const sixDigits = (n: number): string => String(n).padStart(6, '0');

it('C39-T token canary: the enrolment token kept at rest cannot be rebuilt from the invitation address', async () => {
  mountAuthHook();
  w.provider.mode('accept');
  const address = addressFor('rebuilt');
  const id = await invite(c.admin, address);
  const live = providerHash(address, sixDigits(randomInt(0, 1_000_000)));
  expect((await postAuth(authMessage('invite', address, live))).status).toBe(200);
  expect(mailTo(address)).toHaveLength(1);
  const [kept] = await w.db.admin.execute<{ token_hash: string; address: string }>(
    `select t.token_hash, i.address
       from public.enrolment_tokens t
       join public.invitations i on i.id = t.invitation_id
      where t.invitation_id = $1`,
    [id],
  );
  expect(kept).toBeDefined();
  let rebuilt: string | undefined;
  for (let n = 0; n < 1_000_000 && rebuilt === undefined; n += 1) {
    const guess = providerHash(String(kept?.address), sixDigits(n));
    if (createHash('sha256').update(guess).digest('hex') === kept?.token_hash) rebuilt = guess;
  }
  expect(rebuilt, 'a live enrolment token, rebuilt from the database alone').toBeUndefined();
}, 120_000);

it('C39-T isolation: a person whose address already holds a login in another business can still be invited', async () => {
  w.provider.mode('accept');
  // GoTrue's answer to an invite link for a confirmed user, as the stand-in gives it.
  auth.fake.mode('exists');
  const address = addressFor('enrolled-elsewhere');
  try {
    expect(await send(await invite(c.admin, address))).toMatchObject({ ok: true });
    expect(mailTo(address)).toHaveLength(1);
  } finally {
    auth.fake.mode('accept');
  }
});
