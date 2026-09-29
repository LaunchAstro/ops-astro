// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { CSRF_HEADER, SESSION_HEADER, pathOf } from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';

const ISSUER = 'http://127.0.0.1:54391';

async function tokenFor(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: now,
    exp: now + 600,
  });
}

describe('S0-6 isolation at the session cookie', () => {
  it('a tab cannot read another person’s token under its own session cookie name', async () => {
    const executeRead = vi.fn(() => Promise.resolve({ ok: true }));
    const api = createApi({
      database: {} as Database,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: () => Promise.resolve('business-alpha'),
      executeRead: executeRead as never,
      executeCommand: (() => Promise.reject(new Error('unexpected command'))) as never,
    });
    const ada = await tokenFor('ada');
    const mia = await tokenFor('mia');
    const session = sessionIdOf(ada);
    const request = (cookies: string) =>
      api.request(`/api/b/alpha${pathOf('task.board')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER]: '1',
          'sec-fetch-site': 'same-origin',
          [SESSION_HEADER]: session,
          cookie: cookies,
        },
        body: '{}',
      });

    const name = cookieNameFor(session);
    expect((await request(`${name}=${ada}`)).status).toBe(200);
    executeRead.mockClear();
    // A second cookie with the same name cannot make Ada's tab read as Mia.
    const swapped = await request(`${name}=${ada}; ${name}=${mia}`);
    expect(swapped.status).toBeGreaterThanOrEqual(400);
    expect(executeRead).not.toHaveBeenCalled();

    const substituted = await request(`${name}=${mia}`);
    expect(substituted.status).toBeGreaterThanOrEqual(400);
    expect(executeRead).not.toHaveBeenCalled();
  });
});
