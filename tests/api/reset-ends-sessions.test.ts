// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset ends every session the login had, in every business, from `begin`
// on: the window `begin` opens does the ending, so a page that wrote the
// password and never called `changed` (a crash, a lost answer) leaves no old
// session usable. Once `changed` settles the window, a new sign-in is served.
// Against the pinned GoTrue (`reset-world.ts`).

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  alpha,
  begin,
  bravo,
  changed,
  door,
  linkMinted,
  linkSession,
  personIn,
  signIn,
  providerReady,
  writePassword,
  useResetWorld,
} from './reset-world.ts';

const withProvider = it.skipIf(!providerReady);

useResetWorld('rstend');

const NEW_PASSWORD = 'a-new-password-for-reset';

withProvider(
  'a session signed in before begin is refused in both businesses after the write, with no changed call',
  async () => {
    const person = await personIn(alpha, bravo);
    const old = await signIn(person);
    expect(await door(old, 'alpha')).toBe('served');
    expect(await door(old, 'bravo')).toBe('served');
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    expect((await writePassword(recovery, NEW_PASSWORD)).status).toBe(200);
    // No `changed`: the page crashed after the provider's write.
    expect(await door(old, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
    expect(await door(old, 'bravo')).toBe('AUTH_SESSION_EXPIRED');
  },
  60_000,
);

withProvider(
  'a sign-in after the window settles is served, and the old session stays refused',
  async () => {
    const person = await personIn(alpha, bravo);
    const old = await signIn(person);
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    expect((await changed(recovery, NEW_PASSWORD)).status).toBe(200);
    // The provider stamps a sign-in in whole seconds; the next one is past the settle.
    await delay(1100);
    const fresh = await signIn(person, NEW_PASSWORD);
    expect(await door(fresh, 'alpha')).toBe('served');
    expect(await door(fresh, 'bravo')).toBe('served');
    expect(await door(old, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
  },
  60_000,
);
