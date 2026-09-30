// SPDX-License-Identifier: AGPL-3.0-only
//
// An expired sign-in's session cookie does not outlive it.
//
// Each sign-in gets a cookie of its own, with no `Max-Age`, so it lives until
// the browser session ends. When its token runs out the API answers
// `AUTH_SESSION_EXPIRED` and the page sends the person to sign in again; the
// next sign-in adds a second cookie beside the dead one. Only the API can
// clear an `HttpOnly` cookie, so unless the expired answer clears it, every
// hourly re-sign-in in one browser session adds about a kilobyte to every
// request under the person prefix, until the server refuses the headers.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { SESSION_COOKIE, SESSION_HEADER, SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { BOARD, ISSUER, SAME_ORIGIN, database, post } from './session-cookie.fixture.ts';

function build() {
  return createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
    executeRead: (() => Promise.resolve({ ok: true, tasks: [] })) as never,
    executeCommand: (() => Promise.resolve({ recordId: 'r-1', revision: 1 })) as never,
  });
}

/** A browser's cookie jar for the API's origin, as far as `Set-Cookie` moves it. */
function jar() {
  const held = new Map<string, string>();
  return {
    take(response: Response): void {
      for (const line of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
        const [name = '', ...value] = pair.split('=');
        const gone = attributes.some(
          (a) => /^max-age=0$/iu.test(a) || (/^expires=/iu.test(a) && Date.parse(a.slice(8)) < Date.now()),
        );
        if (gone) held.delete(name);
        else held.set(name, value.join('='));
      }
    },
    header: (): string => [...held].map(([name, value]) => `${name}=${value}`).join('; '),
    sessions: (): number => [...held.keys()].filter((name) => name.startsWith(SESSION_COOKIE)).length,
  };
}

/** A sign-in whose token lives one minute from `now`, traded for its cookie. */
async function signInFor(api: ReturnType<typeof build>, cookies: ReturnType<typeof jar>, n: number) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signBearer({
    sub: '0b6c1f4e-8f0e-4d8a-9b3e-2f6a7c1d5e90',
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    // The claims GoTrue puts on a password sign-in's access token.
    email: 'mia@alpha.local',
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {
      email: 'mia@alpha.local',
      email_verified: true,
      phone_verified: false,
      sub: '0b6c1f4e-8f0e-4d8a-9b3e-2f6a7c1d5e90',
    },
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: now }],
    is_anonymous: false,
    session_id: `0b6c1f4e-8f0e-4d8a-9b3e-${String(n).padStart(12, '0')}`,
    iat: now,
    exp: now + 60,
  });
  const answer = await post(api, SESSION_PATH, { ...SAME_ORIGIN, authorization: `Bearer ${token}` });
  expect(answer.status).toBe(200);
  cookies.take(answer);
  return ((await answer.json()) as { session: string }).session;
}

/** The token runs out, and the tab's next call is answered expired. */
async function expire(
  call: (headers: Record<string, string>) => Promise<Response>,
  cookies: ReturnType<typeof jar>,
  session: string,
) {
  vi.setSystemTime(Date.now() + 120_000);
  const answer = await call({ ...SAME_ORIGIN, cookie: cookies.header(), [SESSION_HEADER]: session });
  expect(answer.status).toBe(401);
  expect(((await answer.json()) as { code: string }).code).toBe('AUTH_SESSION_EXPIRED');
  cookies.take(answer);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("an expired sign-in's session cookie does not outlive it", () => {
  it('signing in again after the session expired leaves the browser one session cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const cookies = jar();
    const first = await signInFor(api, cookies, 1);
    await expire(async (headers) => await post(api, BOARD, headers), cookies, first);
    await signInFor(api, cookies, 2);
    expect(cookies.sessions()).toBe(1);
  });

  it('two working days (twenty) of hourly re-sign-ins in one restored browser session still leaves the API answering', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const call = async (headers: Record<string, string>) =>
      await fetch(`${base}${BOARD}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
    try {
      const cookies = jar();
      let session = '';
      for (let n = 1; n <= 20; n += 1) {
        // eslint-disable-next-line no-await-in-loop -- one sign-in after another, as a day goes
        session = await signInFor(api, cookies, n);
        // eslint-disable-next-line no-await-in-loop
        if (n < 20) await expire(call, cookies, session);
      }
      const answer = await call({ ...SAME_ORIGIN, cookie: cookies.header(), [SESSION_HEADER]: session });
      expect(answer.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
