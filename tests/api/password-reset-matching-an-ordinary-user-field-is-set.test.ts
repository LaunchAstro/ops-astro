// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset's password and the login provider's answer. An honest user object
// carries ordinary values (`aud` and `role` are `authenticated`), and a
// password may spell one of them or a part of one: that reset is set. A field
// named for a password is still a fault (`c40-password-set-answer.test.ts`).

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { json } from './c58-sessions-world.ts';
import {
  answerWith,
  auditOf,
  freshMember,
  mintToken,
  setPassword,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();
const CHANGED = 'account.password_changed';

/** The provider's honest user object for `id`. */
const userObject = (id: string): Record<string, unknown> => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'reset-person@example.test',
  app_metadata: { provider: 'email', providers: ['email'] },
});

describe.skipIf(serverUrl === undefined)('a reset password and the provider user object', () => {
  it.each([
    { how: 'equal to', password: 'authenticated' },
    { how: 'contained in', password: 'uthenticated' },
  ])('a reset to a password $how the user object’s role is set', async ({ password }) => {
    expect(Buffer.byteLength(password)).toBeGreaterThanOrEqual(12);
    const member = await freshMember('ordinary-value');
    const id = member.presented.subject;
    answerWith(json(200, userObject(id)));
    const set = await setPassword(await mintToken(id), password);
    const audits = (await auditOf(world.alpha, CHANGED)).filter(
      (row) => row.actor_id === member.actorId,
    );
    expect({ status: set.status, body: set.body, audits: audits.length }).toEqual({
      status: 200,
      body: { passwordSet: true },
      audits: 1,
    });
  });
});
