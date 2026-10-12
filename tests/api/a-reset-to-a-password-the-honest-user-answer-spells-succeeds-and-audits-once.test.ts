// SPDX-License-Identifier: AGPL-3.0-only
//
// The honest user object the provider answers a password update with carries
// `aud` and `role` = `authenticated`. A reset to that word, or to a part of it,
// is set and audited once through the real reset route, and the same link
// used again is refused.
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

describe.skipIf(serverUrl === undefined)('ordinary provider user fields', () => {
  it.each(['authenticated', 'uthenticated'])(
    'a reset to %s, which the honest user answer spells, succeeds once and audits once',
    async (password) => {
      const member = await freshMember('sol-ordinary-role');
      const id = member.presented.subject;
      answerWith(
        json(200, {
          id,
          aud: 'authenticated',
          role: 'authenticated',
          email: 'reset@example.test',
          app_metadata: { provider: 'email', providers: ['email'] },
        }),
      );
      const token = await mintToken(id);
      const result = await setPassword(token, password);
      const repeated = await setPassword(token, password);
      const audits = (await auditOf(world.alpha, 'account.password_changed')).filter(
        (row) => row.actor_id === member.actorId,
      );
      expect({
        status: result.status,
        body: result.body,
        audits: audits.length,
        repeatedStatus: repeated.status,
        repeatedBody: repeated.body,
      }).toEqual({
        status: 200,
        body: { passwordSet: true },
        audits: 1,
        repeatedStatus: 401,
        repeatedBody: { code: 'RESET_LINK_INVALID' },
      });
    },
  );
});
