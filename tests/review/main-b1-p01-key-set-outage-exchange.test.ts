// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-B1 review round 1, rs-6 (beside REVIEW-MAIN-B1 p01-1's proof). The
// session exchange (`POST /api/session`) during a key set outage: the token
// cannot be checked, so the answer is 503 `SERVICE_UNAVAILABLE`, not a refusal,
// and no cookie is set.

import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import type { KeySetFetch } from '../../apps/api/auth/jwks.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { TEST_KEY_SET_URL } from '../support/sign-in.ts';
import { ISSUER, SAME_ORIGIN, database, post, signInOf } from '../api/session-cookie.fixture.ts';

const unreachable: KeySetFetch = async () => await Promise.reject(new TypeError('fetch failed'));

describe('FIX-B1 rs-6: the session exchange during a key set outage', () => {
  it('answers 503 SERVICE_UNAVAILABLE and sets no cookie', async () => {
    const api = createApi({
      database,
      verify: createSupabaseVerifier({
        issuer: ISSUER,
        keySetUrl: TEST_KEY_SET_URL,
        fetch: unreachable,
      }),
      resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
      executeRead: (() => Promise.resolve({ ok: true, tasks: [] })) as never,
      executeCommand: (() => Promise.resolve({ recordId: 'r-1', revision: 1 })) as never,
    });
    const mia = await signInOf('mia');

    const answer = await post(api, SESSION_PATH, {
      ...SAME_ORIGIN,
      authorization: `Bearer ${mia.token}`,
    });

    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(answer.headers.getSetCookie()).toEqual([]);
  });
});
