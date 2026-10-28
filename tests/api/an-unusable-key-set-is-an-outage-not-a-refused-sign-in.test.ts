// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider answers its key set with 200 and a body no key can be read
// from: an HTML page, a body that is not JSON, an empty list. The token it
// was asked to check is then unchecked, as it is when the set cannot be
// reached at all, so the door answers 503 and the page keeps its session: no `AUTH_UNKNOWN_LOGIN`, no cleared cookie, no
// failed sign-in counted (B7). Only a set that publishes private key material
// is refused like the token, and which of the two answers a token gets
// follows the latest fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { KEY_SET_CACHE_MS, KEY_SET_COOLDOWN_MS } from '../../apps/api/auth/jwks.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import type { SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { TEST_KEY_SET, TEST_KEY_SET_URL } from '../support/sign-in.ts';
import { BOARD, ISSUER, SAME_ORIGIN, database, post, signInOf } from './session-cookie.fixture.ts';

const [published] = TEST_KEY_SET.keys;
const UNUSABLE: readonly (readonly [string, () => Response])[] = [
  [
    'an HTML page',
    () =>
      new Response('<!doctype html><title>Gateway</title><p>Try again later.</p>', {
        headers: { 'content-type': 'text/html' },
      }),
  ],
  ['a body that is not JSON', () => new Response('{"keys": [')],
  ['an empty key list', () => Response.json({ keys: [] })],
  [
    'keys in no algorithm the door uses',
    () => Response.json({ keys: [{ ...published, alg: 'ES384' }] }),
  ],
];
const PRIVATE = (): Response => Response.json({ keys: [{ ...published, d: 'not-published' }] });
const UNREACHABLE = (): Response => {
  throw new TypeError('fetch failed');
};

/** An API whose key set fetch answers with whatever `answer` is now. */
function apiAnswering(answer: { current: () => Response }) {
  const signals: SecuritySignal[] = [];
  const api = createApi({
    database,
    verify: createSupabaseVerifier({
      issuer: ISSUER,
      keySetUrl: TEST_KEY_SET_URL,
      fetch: async () => await Promise.resolve().then(() => answer.current()),
    }),
    resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
    executeRead: (() => Promise.resolve({ ok: true, tasks: [] })) as never,
    executeCommand: (() => Promise.resolve({ recordId: 'r-1', revision: 1 })) as never,
    observe: (signal) => signals.push(signal),
  });
  return { api, signals };
}

/** A signed-in tab's board read: its status, code, cleared cookies and failed sign-ins. */
async function boardRead({ api, signals }: ReturnType<typeof apiAnswering>) {
  const mia = await signInOf('mia');
  const before = signals.length;
  const answer = await post(api, BOARD, {
    ...SAME_ORIGIN,
    cookie: mia.cookie,
    [SESSION_HEADER]: mia.id,
  });
  const name = `${mia.cookie.split('=')[0]}=`;
  return {
    status: answer.status,
    code: ((await answer.json()) as { code?: string }).code,
    cleared: answer.headers.getSetCookie().filter((line) => line.startsWith(name)).length,
    failed: signals.slice(before).filter((signal) => signal.kind === 'sign-in-failed').length,
  };
}

const OUTAGE = { status: 503, code: 'SERVICE_UNAVAILABLE', cleared: 0, failed: 0 };

describe('an unusable key set is an outage, not a refused sign-in', () => {
  it.each(UNUSABLE)(
    'a key set answered as %s keeps a good session and counts no failed sign-in',
    async (_name, answer) => {
      expect(await boardRead(apiAnswering({ current: answer }))).toEqual(OUTAGE);
    },
  );
});

describe('the answer a token gets follows the latest key set fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a set publishing private key material refuses the token, and an outage after it does not', async () => {
    const answer = { current: PRIVATE };
    const api = apiAnswering(answer);
    expect(await boardRead(api)).toMatchObject({ status: 401, code: 'AUTH_UNKNOWN_LOGIN' });

    answer.current = UNREACHABLE;
    vi.setSystemTime(Date.now() + KEY_SET_COOLDOWN_MS + 1);
    expect(await boardRead(api)).toEqual(OUTAGE);
  });

  it('an outage answers 503, and a set publishing private key material after it refuses', async () => {
    const answer = { current: UNREACHABLE };
    const api = apiAnswering(answer);
    expect(await boardRead(api)).toEqual(OUTAGE);
    // Inside the cooldown nothing is fetched, and the answer is still the outage's.
    answer.current = PRIVATE;
    expect(await boardRead(api)).toEqual(OUTAGE);

    vi.setSystemTime(Date.now() + KEY_SET_COOLDOWN_MS + 1);
    expect(await boardRead(api)).toMatchObject({ status: 401, code: 'AUTH_UNKNOWN_LOGIN' });
  });

  it('a set is cached longer than the gap between fetches, so no answer outlives its fetch', () => {
    // `supabase.ts` reads its outage flag only when no fetched set is fresh,
    // which, with this order, is only ever just after a failed fetch.
    expect(KEY_SET_COOLDOWN_MS).toBeLessThan(KEY_SET_CACHE_MS);
  });
});
