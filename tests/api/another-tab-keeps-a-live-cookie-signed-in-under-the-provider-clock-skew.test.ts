// SPDX-License-Identifier: AGPL-3.0-only
//
// A provider whose clock runs ahead within the skew the verifier allows issues
// a token whose `exp` lies a little past the absolute session limit from the
// API's now. That cookie is a live tab's sign-in, so another tab's read keeps
// it: nothing one request carries is cleared for an `exp` alone while it is
// among the newest.

import { expect, it } from 'vitest';
import { cookieNameFor, staleSessions } from '../../apps/api/auth/session.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../packages/core-records/src/index.ts';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';

const token = (exp: number) =>
  ['e30', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.');

it('another tab keeps a live cookie signed in under the provider clock skew', () => {
  const now = 1_800_000_000;
  const mine = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const headers: Readonly<Record<string, string>> = {
    cookie: [
      `${cookieNameFor(mine)}=${token(now + 3600)}`,
      `${cookieNameFor(other)}=${token(now + 30 + SESSION_ABSOLUTE_SECONDS)}`,
    ].join('; '),
    [SESSION_HEADER]: mine,
  };
  const request = { header: (name: string) => headers[name.toLowerCase()] } as never;
  expect(staleSessions(request, now)).toEqual([]);
});
