// SPDX-License-Identifier: AGPL-3.0-only
//
// The door keeps the newest five other sign-ins' cookies by their tokens'
// `exp`, read unverified. A cookie whose token claims an `exp` no sign-in can
// reach (past the absolute session limit from now) is not a sign-in this API
// issued, so it never holds one of those places ahead of a live tab's cookie.

import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { cookieNameFor, staleSessions } from '../../apps/api/auth/session.ts';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';

const token = (exp: number) =>
  ['e30', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.');

const id = (n: number) => n.toString(16).padStart(32, '0');

async function staleFor(cookies: readonly (readonly [string, string])[], now: number) {
  const app = new Hono().get('/', (c) => c.json(staleSessions(c.req, now)));
  const response = await app.request('/', {
    headers: {
      [SESSION_HEADER]: id(1),
      cookie: cookies.map(([name, value]) => `${name}=${value}`).join('; '),
    },
  });
  return (await response.json()) as string[];
}

it('a planted far-future session cookie takes no live tab slot and is cleared', async () => {
  const now = 1_800_000_000;
  const own = [cookieNameFor(id(1)), token(now + 3600)] as const;
  const live = [cookieNameFor(id(2)), token(now + 1800)] as const;
  const planted = [3, 4, 5, 6, 7].map(
    (n) => [cookieNameFor(id(n)), token(now + 10 * 365 * 24 * 60 * 60)] as const,
  );
  const stale = await staleFor([own, live, ...planted], now);
  expect(stale).not.toContain(live[0]);
  expect(stale.toSorted()).toEqual(planted.map(([name]) => name).toSorted());
});

it('a session cookie whose token lives no longer than the absolute limit keeps its place', async () => {
  const now = 1_800_000_000;
  const own = [cookieNameFor(id(1)), token(now + 3600)] as const;
  const longest = [cookieNameFor(id(2)), token(now + 12 * 60 * 60)] as const;
  expect(await staleFor([own, longest], now)).toEqual([]);
});
