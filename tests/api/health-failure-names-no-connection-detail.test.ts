// SPDX-License-Identifier: AGPL-3.0-only
//
// `/api/health` answers anyone, with no credential, so a failure it reports
// names a bounded fault code and never the database's own words. Through the
// server's own wiring (`composeApi`) over a runtime pool whose connection is
// refused with an address in its message: the answer is 503, `unreachable`
// and `ECONNREFUSED`, and neither the address nor the port is in it. It goes
// red if health serialises the exception's message again. No database: the
// stand-in pool refuses every transaction.

import { expect, it } from 'vitest';
import { keySetUrlFor } from '../../apps/api/auth/supabase.ts';
import { composeApi } from '../../apps/api/server.ts';
import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { TEST_ISSUER as ISSUER } from '../support/sign-in.ts';

const ADDRESS = '192.0.2.17';

it('a refused database connection is reported by its code, with no address or port', async () => {
  const refused = Object.assign(new Error(`connect ECONNREFUSED ${ADDRESS}:5432`), {
    code: 'ECONNREFUSED',
  });
  const database = {
    withBusiness: async () => await Promise.reject(refused),
    close: async () => await Promise.resolve(),
  } as unknown as Database;
  const { app } = composeApi({
    database,
    admin: {} as AdminConnection,
    signIn: { issuer: ISSUER, keySetUrl: keySetUrlFor('', ISSUER) ?? '' },
    keys: runtimeKeys({}),
  });

  const response = await app.fetch(new Request('http://api.test/api/health'));
  const text = await response.text();

  expect(response.status).toBe(503);
  expect(JSON.parse(text)).toMatchObject({
    ok: false,
    database: 'unreachable',
    detail: 'ECONNREFUSED',
  });
  expect(text).not.toContain(ADDRESS);
  expect(text).not.toContain('5432');
});
