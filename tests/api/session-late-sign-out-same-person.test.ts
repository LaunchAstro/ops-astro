// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof from review 3 on #107 (proof-REV107C-fe180f5.patch), adapted to
// the fix Sol described: each sign-in has its own cookie id, which its tab
// names. Changed, and only these: the header is the session id rather than the
// person (SESSION_HEADER for SUBJECT_HEADER), the late sign-out and the board
// read name the id their tab was given, and the jar is read by that id's
// cookie name. The as-sent file is red at 73ec54b and kept as evidence.

import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { CSRF_HEADER, SESSION_HEADER, pathOf } from '../../packages/core-wire/src/index.ts';
import { signBearer, TEST_ISSUER, testSignIn } from '../support/sign-in.ts';

const ISSUER: string = TEST_ISSUER;
const SAME_ORIGIN = { [CSRF_HEADER]: '1', 'sec-fetch-site': 'same-origin' };

const api = createApi({
  database: {} as Database,
  verify: createSupabaseVerifier(testSignIn(ISSUER)),
  resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
  executeRead: ((_db: unknown, _business: string, presented: unknown) =>
    Promise.resolve({ ok: true, presented })) as never,
  executeCommand: (() => Promise.reject(new Error('unexpected command'))) as never,
});

const send = (path: string, headers: Record<string, string>) =>
  api.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });

async function tokenFor(session: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    sub: 'mia',
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: now,
    exp: now + 600,
    jti: session,
  });
}

describe('S0-6 session cookie across tabs', () => {
  it('late sign-out cannot clear a newer session for the same person', async () => {
    const jar = new Map<string, string>();
    const land = (response: Response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = line.split(';');
        const [name = '', ...value] = pair.trim().split('=');
        if (attributes.some((part) => part.trim().toLowerCase() === 'max-age=0')) jar.delete(name);
        else jar.set(name, value.join('='));
      }
    };
    const exchange = async (token: string) =>
      await send('/api/session', { authorization: `Bearer ${token}`, ...SAME_ORIGIN });
    const first = await tokenFor('first');
    const second = await tokenFor('second');
    expect(first).not.toBe(second);

    land(await exchange(first));
    const late = await send('/api/session/end', {
      [SESSION_HEADER]: sessionIdOf(first),
      ...SAME_ORIGIN,
    });
    land(await exchange(second));
    expect(jar.get(cookieNameFor(sessionIdOf(second)))).toBe(second);
    land(late);

    const board = await send(`/api/b/alpha${pathOf('task.board')}`, {
      cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      [SESSION_HEADER]: sessionIdOf(second),
      ...SAME_ORIGIN,
    });
    expect(board.status).toBe(200);
    expect(await board.json()).toMatchObject({ ok: true, presented: { subject: 'mia' } });
  });
});
