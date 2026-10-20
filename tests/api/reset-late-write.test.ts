// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset window left unsettled ends sessions only up to its bound, but its
// recovery session can still write a password at the provider after it, which
// deletes the login's other sessions there and nothing here. A session signed
// in after the bound is served until such a write, and refused in every
// business from it, even when the recovery session was refreshed and writes
// after its first token's expiry. Each case waits out the real five-minute
// bound, no clock moved; the harness's tokens live 330 seconds. Against the
// pinned GoTrue (`reset-world.ts`).

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  alpha,
  begin,
  bravo,
  db,
  door,
  linkMinted,
  linkSession,
  personIn,
  providerReady,
  refreshed,
  signIn,
  useResetWorld,
  writePassword,
} from './reset-world.ts';

useResetWorld('rstlate');

const withProvider = it.skipIf(!providerReady);

/** Milliseconds since the epoch at which the subject's window reaches its bound. */
async function boundOf(subject: string): Promise<number> {
  const [window] = await db.admin.execute<{ until: number }>(
    `select extract(epoch from open_until)::float8 * 1000 as until from ops.subject_resets
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [subject],
  );
  if (window === undefined) throw new Error('begin opened no window');
  return window.until;
}

/** The token's `exp`, in milliseconds since the epoch. */
const expiryOf = (token: string): number =>
  1000 *
  Number(
    (
      JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
        exp?: unknown;
      }
    ).exp,
  );

withProvider(
  'a session signed in after the bound does not outlive a password written after it',
  async () => {
    const person = await personIn(alpha, bravo);
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    await delay(Math.max(0, (await boundOf(person.subject)) - Date.now()) + 1100);
    const late = await signIn(person);
    expect(await door(late, 'alpha')).toBe('served');
    expect((await writePassword(recovery, 'a-password-written-late')).status).toBe(200);
    // No `changed`: the write came after the bound, from no page of ours.
    expect(await door(late, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
    expect(await door(late, 'bravo')).toBe('AUTH_SESSION_EXPIRED');
  },
  330_000,
);

withProvider(
  'nor one written by the refreshed recovery session after its first token expired',
  async () => {
    const person = await personIn(alpha, bravo);
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    await delay(Math.max(0, (await boundOf(person.subject)) - Date.now()) + 1100);
    const renewed = await refreshed(recovery);
    await delay(Math.max(0, expiryOf(recovery) - Date.now()) + 1100);
    const late = await signIn(person);
    expect(await door(late, 'alpha')).toBe('served');
    expect((await writePassword(renewed, 'a-password-written-later')).status).toBe(200);
    expect(await door(late, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
    expect(await door(late, 'bravo')).toBe('AUTH_SESSION_EXPIRED');
  },
  400_000,
);
