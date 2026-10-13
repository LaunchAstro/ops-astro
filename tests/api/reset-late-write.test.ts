// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset window left unsettled ends sessions only up to its bound, but its
// recovery session can still write a password at the provider after it, which
// deletes the login's other sessions there and nothing here. A session signed
// in after the bound is served until such a write, and refused in every
// business from it. Waits out the real five-minute bound, no clock moved.
// Against the pinned GoTrue (`reset-world.ts`).

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
  signIn,
  useResetWorld,
  writePassword,
} from './reset-world.ts';

useResetWorld('rstlate');

it.skipIf(!providerReady)(
  'a session signed in after the bound does not outlive a password written after it',
  async () => {
    const person = await personIn(alpha, bravo);
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    const [window] = await db.admin.execute<{ until: number }>(
      'select extract(epoch from max(open_until))::float8 * 1000 as until from ops.subject_resets',
    );
    if (window === undefined) throw new Error('begin opened no window');
    await delay(Math.max(0, window.until - Date.now()) + 1100);
    const late = await signIn(person);
    expect(await door(late, 'alpha')).toBe('served');
    expect((await writePassword(recovery, 'a-password-written-late')).status).toBe(200);
    // No `changed`: the write came after the bound, from no page of ours.
    expect(await door(late, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
    expect(await door(late, 'bravo')).toBe('AUTH_SESSION_EXPIRED');
  },
  330_000,
);
