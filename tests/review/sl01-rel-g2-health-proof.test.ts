// SPDX-License-Identifier: AGPL-3.0-only
// Narrow re-check proof: the health route must measure the runtime login.

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client, loginIn } from '../db/backup-identity.fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

let db: FreshDatabase;
let login: { url: string; name: string };

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'relhealth' });
  login = await loginIn(db, 'ops_astro_lookup', 'health');
}, 90_000);

afterAll(async () => {
  await db?.drop();
  if (login === undefined) return;
  const cleanup = new Client(databaseUrlFromEnvironment() ?? '');
  await cleanup.query(`drop role if exists "${login.name}"`).finally(() => cleanup.end());
});

it('G2 health measures the runtime login when lookup is reachable', async () => {
  const runtime = new URL(db.appUrl);
  runtime.port = '1';
  const keyId = 'test/rel-health@1';
  const handle = createFunctionHandler({
    DATABASE_URL: runtime.toString(),
    DATABASE_LOOKUP_URL: login.url,
    GOTRUE_URL: 'http://127.0.0.1:54391',
    SERVED_HOST: 'ops.example.test',
    DELEGATION_CREDENTIAL_KEY_ID: keyId,
    DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
  });
  const response = await handle(
    new Request('https://ops.example.test/api/health', {
      headers: { host: 'ops.example.test' },
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ database: 'unreachable' });
});
