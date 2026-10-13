// SPDX-License-Identifier: AGPL-3.0-only
//
// A product session begins only at a password sign-in. The login provider
// also issues sessions from a mailed link: a recovery or magic link is an
// `otp` session, and its older names (`magiclink`, `recovery`, `invite`,
// `email/signup`) are links too. Whoever opens such a link holds a provider
// session, but a link only lets its holder set a password (C40, C39-T); it
// never signs them into content. So a token whose `amr` holds no `password`
// entry has no first sign-in, and every product route answers
// `AUTH_SESSION_EXPIRED`, whose answer is to sign in with a password.
//
// The clock is frozen (only `Date`). No database and no network: the fixture
// key set and stub executors, as the C58 cookie lifetime cases use.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { SESSION_HEADER, SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { BOARD, ISSUER, SAME_ORIGIN, database, post } from './session-cookie.fixture.ts';

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

/** A token GoTrue would issue for a session begun by `method` a minute ago. */
async function begunBy(method: string): Promise<string> {
  return await signBearer({
    sub: 'mia',
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    aal: 'aal1',
    iat: NOW,
    exp: NOW + 600,
    session_id: '6f1c2a9e-3d4b-4c5d-8e7f-0a1b2c3d4e5f',
    amr: [{ method, timestamp: NOW - 60 }],
  });
}

async function trade(api: ReturnType<typeof createApi>, token: string): Promise<Response> {
  return await post(api, SESSION_PATH, { authorization: `Bearer ${token}`, ...SAME_ORIGIN });
}

async function asTab(api: ReturnType<typeof createApi>, token: string): Promise<Response> {
  const id = sessionIdOf(token);
  return await post(api, BOARD, {
    cookie: `${cookieNameFor(id)}=${token}`,
    [SESSION_HEADER]: id,
    ...SAME_ORIGIN,
  });
}

async function asBearer(api: ReturnType<typeof createApi>, token: string): Promise<Response> {
  return await post(api, BOARD, { authorization: `Bearer ${token}` });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

const LINKS = ['otp', 'magiclink', 'recovery', 'invite', 'email/signup'];

it.each(LINKS)('a session begun by a mailed link (%s) is given no cookie', async (method) => {
  const { api } = build();
  const answer = await trade(api, await begunBy(method));
  expect(answer.status).toBe(401);
  expect(await answer.json()).toMatchObject({ refused: true, code: 'AUTH_SESSION_EXPIRED' });
  expect(answer.headers.get('set-cookie')).toBeNull();
});

it.each(LINKS)(
  'a session begun by a mailed link (%s) reads nothing, by cookie or by bearer',
  async (method) => {
    const { api, executeRead } = build();
    const token = await begunBy(method);
    const answers = [await asTab(api, token), await asBearer(api, token)];
    expect(answers.map((answer) => answer.status)).toEqual([401, 401]);
    const bodies: unknown[] = await Promise.all(answers.map(async (answer) => await answer.json()));
    for (const body of bodies) {
      expect(body).toMatchObject({ refused: true, code: 'AUTH_SESSION_EXPIRED' });
    }
    expect(executeRead).not.toHaveBeenCalled();
  },
);

it('a password sign-in is served, by cookie and by bearer', async () => {
  const { api, executeRead } = build();
  const token = await begunBy('password');
  expect((await trade(api, token)).status).toBe(200);
  expect((await asTab(api, token)).status).toBe(200);
  expect((await asBearer(api, token)).status).toBe(200);
  expect(executeRead).toHaveBeenCalledTimes(2);
});
