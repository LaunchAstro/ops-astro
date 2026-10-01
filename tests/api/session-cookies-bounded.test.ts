// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-B1 review round 1, rs-1 (beside REVIEW-MAIN-B1 p01-2's proof). Clearing
// lapsed cookies at the door helps only a request that reaches the door. Tabs
// opened faster than their tokens run out (24 tabs, 2 minutes apart, each token
// living an hour) would push the Cookie header past Node's 16 KB limit, and
// from then on every request under the person prefix is answered 431 before
// the door can clear anything, for as long as the cookies' `Max-Age` (up to
// 12 hours). The door keeps only a few other sign-ins' cookies, so neither the
// burst nor a new tab two hours later is ever answered 431.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  SESSION_PATH,
} from '../../packages/core-wire/src/index.ts';
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

/** The browser's jar for the API's origin, honouring `Max-Age`. */
function jar() {
  const held = new Map<string, { value: string; until: number }>();
  const live = () => [...held].filter(([, cookie]) => cookie.until > Date.now());
  return {
    take(response: Response): void {
      for (const line of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
        const [name = '', ...value] = pair.split('=');
        const maxAge = attributes.find((a) => /^max-age=/iu.test(a));
        const seconds = maxAge === undefined ? Infinity : Number(maxAge.slice(8));
        if (seconds <= 0) held.delete(name);
        else held.set(name, { value: value.join('='), until: Date.now() + seconds * 1000 });
      }
    },
    header: (): string =>
      live()
        .map(([name, { value }]) => `${name}=${value}`)
        .join('; '),
    sessions: (): number => live().filter(([name]) => name.startsWith(SESSION_COOKIE)).length,
  };
}

/** A new tab signs in with the claims GoTrue puts on a password sign-in. */
async function newTab(
  api: ReturnType<typeof build>,
  cookies: ReturnType<typeof jar>,
  n: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sub = '0b6c1f4e-8f0e-4d8a-9b3e-2f6a7c1d5e90';
  const token = await signBearer({
    sub,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    email: 'mia@alpha.local',
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { email: 'mia@alpha.local', email_verified: true, phone_verified: false, sub },
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: now }],
    is_anonymous: false,
    session_id: `0b6c1f4e-8f0e-4d8a-9b3e-${String(n).padStart(12, '0')}`,
    iat: now,
    exp: now + 3600,
  });
  const answer = await post(api, SESSION_PATH, {
    ...SAME_ORIGIN,
    authorization: `Bearer ${token}`,
  });
  expect(answer.status).toBe(200);
  cookies.take(answer);
  return ((await answer.json()) as { session: string }).session;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FIX-B1 rs-1: tabs opened inside one token lifetime never lock the person prefix out', () => {
  it('24 tabs 2 minutes apart, then a new tab 2 hours later: every read is answered, none 431', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const cookies = jar();
    const read = async (session: string, n: number) => {
      const held = cookies.sessions();
      const answer = await fetch(`${base}${BOARD}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...SAME_ORIGIN,
          cookie: cookies.header(),
          [SESSION_HEADER]: session,
        },
        body: '{}',
      });
      cookies.take(answer);
      expect(answer.status, `tab ${String(n)} read with ${String(held)} session cookies held`).toBe(
        200,
      );
    };
    try {
      for (let n = 1; n <= 24; n += 1) {
        // eslint-disable-next-line no-await-in-loop -- one tab after another
        await read(await newTab(api, cookies, n), n);
        // The tab is closed: its cookie is never named again.
        vi.setSystemTime(Date.now() + 2 * 60_000);
      }
      vi.setSystemTime(Date.now() + 2 * 3600_000);
      await read(await newTab(api, cookies, 25), 25);
    } finally {
      server.close();
    }
  });
});
