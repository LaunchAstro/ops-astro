// SPDX-License-Identifier: AGPL-3.0-only
//
// `/api/health` answers anyone, with no credential, so a database failure it
// reports is one fixed sentence and never the database's own words (#1326).
// The cause goes to the API's own log by its bounded fault code, as the fault
// handler logs one. Through the server's own wiring (`composeApi`) over a
// runtime pool whose connection is refused with an address in its message:
// the answer is 503, `unreachable` and the fixed sentence, and neither the
// address nor the port is in it or in the log line. No database: the
// stand-in pool refuses every transaction.

import { afterEach, expect, it, vi } from 'vitest';
import { keySetUrlFor } from '../../apps/api/auth/supabase.ts';
import { composeApi } from '../../apps/api/server.ts';
import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { TEST_ISSUER as ISSUER } from '../support/sign-in.ts';

const ADDRESS = '192.0.2.17';

afterEach(() => {
  vi.restoreAllMocks();
});

it('a refused database connection is reported in a fixed sentence and logged by its code, with no address or port', async () => {
  const logged: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...line: unknown[]) => {
    logged.push(line.map(String).join(' '));
  });
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
    detail: 'The database did not answer.',
  });
  expect(text).not.toContain(ADDRESS);
  expect(text).not.toContain('5432');
  const health = logged.filter((line) => line.includes('health'));
  expect(health).toStrictEqual(['api: health: the database did not answer (ECONNREFUSED)']);
  expect(logged.join('\n')).not.toContain(ADDRESS);
});
