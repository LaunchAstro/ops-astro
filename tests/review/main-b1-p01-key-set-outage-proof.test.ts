// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-B1 p01-1, red proof. The provider's key set cannot be fetched
// (a cold instance, a provider blip, the 5 s time limit): `jwks.ts` says so as
// `key_set_unavailable`, but `supabase.ts` turns every refusal into nothing,
// so the door answers a good session `AUTH_UNKNOWN_LOGIN`, deletes its cookie
// and counts a failed sign-in. Unavailable must not be drawn as denied (B7).

import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import type { KeySetFetch } from '../../apps/api/auth/jwks.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import type { SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { TEST_KEY_SET_URL } from '../support/sign-in.ts';
import {
  BOARD,
  ISSUER,
  SAME_ORIGIN,
  database,
  post,
  signInOf,
} from '../api/session-cookie.fixture.ts';

const unreachable: KeySetFetch = async () => await Promise.reject(new TypeError('fetch failed'));

describe('REVIEW-MAIN-B1 p01-1: a key set outage is not a failed sign-in', () => {
  it('a good session during a key set outage keeps its cookie and is not told AUTH_UNKNOWN_LOGIN', async () => {
    const signals: SecuritySignal[] = [];
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
      observe: (signal) => signals.push(signal),
    });
    const mia = await signInOf('mia');

    const answer = await post(api, BOARD, {
      ...SAME_ORIGIN,
      cookie: mia.cookie,
      [SESSION_HEADER]: mia.id,
    });
    const body = (await answer.json()) as { code?: string };
    const cleared = answer.headers
      .getSetCookie()
      .filter((line) => line.startsWith(`${mia.cookie.split('=')[0]}=`));

    expect(
      body.code,
      'key set outage answered AUTH_UNKNOWN_LOGIN: the page ends a good session',
    ).not.toBe('AUTH_UNKNOWN_LOGIN');
    expect(cleared, 'key set outage deletes a good session cookie').toEqual([]);
    expect(
      signals.filter((signal) => signal.kind === 'sign-in-failed'),
      'key set outage counted as a failed sign-in',
    ).toEqual([]);
    expect(answer.status, 'key set outage is not answered as unavailable').toBe(503);
  });
});
