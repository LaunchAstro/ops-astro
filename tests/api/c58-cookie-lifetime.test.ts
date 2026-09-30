// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 cookie lifetime (TR-S-R4-1, carried from S0-6): the browser session
// cookie `POST /api/session` sets carries the session's 12-hour absolute
// limit, `SESSION_ABSOLUTE_SECONDS`. Its `Max-Age` is the time left until 12
// hours after the token's first sign-in (the `amr` first-factor time a refresh
// carries unchanged), never more than the whole 12, and a cookie whose token
// is one second past the limit is refused while one second inside is served.
// Batch 1's cookie rules stand beside it: HttpOnly, Secure, SameSite=Lax,
// Path=/api/b/, one cookie per sign-in.
//
// The clock is frozen (only `Date`), so the verifier and the route read the
// same second. No database and no network: the fixture key set, stub executors.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../packages/core-records/src/index.ts';
import { SESSION_HEADER, SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { BOARD, ISSUER, SAME_ORIGIN, cookieOf, database, post } from './session-cookie.fixture.ts';

const NOW = 1_790_000_000;

function build() {
  const executeRead = vi.fn(() => Promise.resolve({ ok: true as const }));
  const api = createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
    executeRead: executeRead as never,
    executeCommand: (() => Promise.reject(new Error('no command here'))) as never,
  });
  return { api, executeRead };
}

/** A freshly refreshed token (`iat` now) for a session first signed in at `signedInAt`. */
async function signedInAt(first: number): Promise<string> {
  return await signBearer({
    sub: 'mia',
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: NOW,
    exp: NOW + 600,
    amr: [{ method: 'password', timestamp: first }],
  });
}

/** The browser trades the token for its cookie. */
async function trade(api: ReturnType<typeof createApi>, token: string): Promise<Response> {
  return await post(api, SESSION_PATH, { authorization: `Bearer ${token}`, ...SAME_ORIGIN });
}

/** A page's read carried by that sign-in's cookie alone. */
async function asTab(api: ReturnType<typeof createApi>, token: string): Promise<Response> {
  const id = sessionIdOf(token);
  return await post(api, BOARD, {
    cookie: `${cookieNameFor(id)}=${token}`,
    [SESSION_HEADER]: id,
    ...SAME_ORIGIN,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

it('C58 cookie lifetime: the cookie lives only what is left of 12 hours from the first sign-in', async () => {
  const { api } = build();
  const token = await signedInAt(NOW - 3 * 3600);
  const answer = await trade(api, token);

  expect(answer.status).toBe(200);
  // One cookie per sign-in, still named from its id, with batch 1's rules.
  expect(answer.headers.getSetCookie()).toHaveLength(1);
  const cookie = cookieOf(answer);
  expect(cookie.name).toBe(cookieNameFor(sessionIdOf(token)));
  expect(cookie.attributes).toEqual(
    expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/api/b/']),
  );
  expect(cookie.attributes).toContain(`max-age=${String(SESSION_ABSOLUTE_SECONDS - 3 * 3600)}`);
});

it('C58 cookie lifetime: a fresh sign-in’s cookie lives 12 hours and never more', async () => {
  const { api } = build();
  expect(SESSION_ABSOLUTE_SECONDS).toBe(12 * 60 * 60);
  const fresh = cookieOf(await trade(api, await signedInAt(NOW)));
  expect(fresh.attributes).toContain(`max-age=${String(SESSION_ABSOLUTE_SECONDS)}`);
  // A first sign-in up to a minute ahead of this clock is served, and its
  // cookie is still held to the whole 12 hours, not 12 hours and a minute.
  const ahead = cookieOf(await trade(api, await signedInAt(NOW + 30)));
  expect(ahead.attributes).toContain(`max-age=${String(SESSION_ABSOLUTE_SECONDS)}`);
});

it('C58 cookie lifetime: one second inside the limit the cookie lives one second', async () => {
  const { api } = build();
  const cookie = cookieOf(await trade(api, await signedInAt(NOW - SESSION_ABSOLUTE_SECONDS + 1)));
  expect(cookie.attributes).toContain('max-age=1');
});

it('C58 cookie lifetime: a cookie one second past the limit is refused, one second inside is served', async () => {
  const { api, executeRead } = build();

  const inside = await asTab(api, await signedInAt(NOW - SESSION_ABSOLUTE_SECONDS + 1));
  expect(inside.status).toBe(200);
  expect(executeRead).toHaveBeenCalledOnce();
  executeRead.mockClear();

  const past = await asTab(api, await signedInAt(NOW - SESSION_ABSOLUTE_SECONDS - 1));
  expect(past.status).toBe(401);
  expect(await past.json()).toMatchObject({ refused: true, code: 'AUTH_SESSION_EXPIRED' });
  expect(executeRead).not.toHaveBeenCalled();
});

it('C58 cookie lifetime: a token one second past the limit is given no cookie', async () => {
  const { api } = build();
  const answer = await trade(api, await signedInAt(NOW - SESSION_ABSOLUTE_SECONDS - 1));
  expect(answer.status).toBe(401);
  expect(await answer.json()).toMatchObject({ refused: true, code: 'AUTH_SESSION_EXPIRED' });
  expect(answer.headers.get('set-cookie')).toBeNull();
});
