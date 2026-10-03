// SPDX-License-Identifier: AGPL-3.0-only
//
// C40 security review, the doors beside the reset that need no database. A
// reset link's session is never traded for the session cookie, at either
// level it claims (F4, F5a); and while the provider's key set cannot be
// reached, the reset answers 503 as the session exchange does, not 401 (F6).

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import type { KeySetFetch } from '../../apps/api/auth/jwks.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { mountPasswordSet, PASSWORD_SET_PATH } from '../../apps/api/password-set.ts';
import { SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn, TEST_KEY_SET_URL } from '../support/sign-in.ts';
import { ISSUER, SAME_ORIGIN, database, post } from './session-cookie.fixture.ts';

/** A reset link's session, at the level it claims. */
async function recoveryBearer(aal: 'aal1' | 'aal2'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const amr = [{ method: 'recovery', timestamp: now - 10 }];
  return await signBearer({
    sub: `mia-${randomUUID()}`,
    aud: 'authenticated',
    iss: ISSUER,
    exp: now + 600,
    aal,
    session_id: randomUUID(),
    amr: aal === 'aal2' ? [...amr, { method: 'totp', timestamp: now - 5 }] : amr,
  });
}

const unreachable: KeySetFetch = async () => await Promise.reject(new TypeError('fetch failed'));

const neverCalled = (): never => {
  throw new Error('nothing past the door is asked in these cases');
};

describe('C40 review: the doors beside the reset', () => {
  it('C40 F4 cookie exchange: a recovery session gets no session cookie, at aal1 or aal2', async () => {
    const api = createApi({
      database,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: neverCalled,
      executeRead: neverCalled as never,
      executeCommand: neverCalled as never,
    });
    for (const aal of ['aal1', 'aal2'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const token = await recoveryBearer(aal);
      // oxlint-disable-next-line no-await-in-loop
      const answer = await post(api, SESSION_PATH, {
        ...SAME_ORIGIN,
        authorization: `Bearer ${token}`,
      });
      expect(answer.status, aal).toBe(401);
      // oxlint-disable-next-line no-await-in-loop
      expect(await answer.json(), aal).toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
      expect(answer.headers.getSetCookie(), aal).toEqual([]);
    }
  });

  it('C40 F6 key set outage: the reset answers 503 RESET_UNAVAILABLE, asking nothing', async () => {
    const api = new Hono();
    mountPasswordSet(api, database, {
      businesses: neverCalled,
      provider: { setPassword: neverCalled, signOut: neverCalled },
      verify: createSupabaseVerifier({
        issuer: ISSUER,
        keySetUrl: TEST_KEY_SET_URL,
        fetch: unreachable,
      }),
    });
    const answer = await api.request(PASSWORD_SET_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await recoveryBearer('aal1')}`,
      },
      body: JSON.stringify({ password: 'a long new password 7f3c' }),
    });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ code: 'RESET_UNAVAILABLE' });
  });
});
