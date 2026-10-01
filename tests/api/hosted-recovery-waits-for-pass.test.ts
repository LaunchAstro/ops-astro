// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';
import { openSchedules } from '../runtime/schedules-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('hosted recovery request gate', () => {
  it('waits for an in-flight hosted reconciliation pass before serving another request', async () => {
    const s = await openSchedules('hostedgate', 100_000);
    const url = new URL(databaseUrlFromEnvironment()!);
    url.pathname = `/${s.db.name}`;
    const holder = new Client(url.toString());
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    try {
      const keyId = 'test/hosted-gate@1';
      const handle = createFunctionHandler({
        DATABASE_URL: s.db.appUrl,
        DATABASE_LOOKUP_URL: (await loginIn(s.db, 'ops_astro_lookup', 'hg')).url,
        GOTRUE_URL: TEST_ISSUER,
        SERVED_HOST: 'ops.example.test',
        GATE_SIGNING_KEY_ID: process.env['GATE_SIGNING_KEY_ID'],
        GATE_SIGNING_SECRET: process.env['GATE_SIGNING_SECRET'],
        DELEGATION_CREDENTIAL_KEY_ID: keyId,
        DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
        RECOVERY_BUSINESS_KEYS: 'schedules-hostedgate',
      });
      await holder.query('begin');
      await holder.query('lock table public.businesses in access exclusive mode');
      const request = () => new Request('https://ops.example.test/api/health', {
        headers: { host: 'ops.example.test' },
      });
      let firstFinished = false;
      first = handle(request()).finally(() => {
        firstFinished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(firstFinished, 'the first request must be waiting on the locked recovery lookup').toBe(false);
      second = handle(request());
      const served = await Promise.race([
        second.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(served).toBe(false);
    } finally {
      await holder.query('rollback');
      await Promise.allSettled([first, second]);
      await holder.end();
      await s.db.drop();
    }
  }, 30_000);
});
