// SPDX-License-Identifier: AGPL-3.0-only
//
// The session exchange (`POST /api/session` in `apps/api/app.ts`) trades a
// bearer for the session cookie only when the verifier answers a verified
// subject. Any other verdict, including one the verifier's type does not name
// today, is refused as an unknown login and sets no cookie. It goes red if the
// exchange lists the verdicts it refuses rather than requiring a subject.

import { expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import type { Verifier } from '../../apps/api/auth/supabase.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { CSRF_HEADER, SESSION_PATH } from '../../packages/core-wire/src/index.ts';

it.each(['revoked', null, 0, ''])(
  'a verdict that is not a verified subject (%s) is refused and sets no cookie',
  async (verdict) => {
    const verify = (async () => await Promise.resolve(verdict)) as unknown as Verifier;
    const api = createApi({
      database: {} as Database,
      verify,
      resolveBusiness: async () => await Promise.resolve(undefined),
      executeRead: (() => undefined) as never,
      executeCommand: (() => undefined) as never,
    });
    const response = await api.fetch(
      new Request(`http://api.test${SESSION_PATH}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer stand-in',
          [CSRF_HEADER]: '1',
          'sec-fetch-site': 'same-origin',
        },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ refused: true, code: 'AUTH_UNKNOWN_LOGIN' });
    expect(response.headers.get('set-cookie')).toBeNull();
  },
);
