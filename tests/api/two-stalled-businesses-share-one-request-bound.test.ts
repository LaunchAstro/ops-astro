// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler, RECOVERY_WAIT_MS } from '../../apps/api/function.ts';
import { Client, dropLogins, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { openSchedules, seedSchedules } from '../runtime/schedules-harness.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the hosted request bound across businesses',
  () => {
    it('Sol proof, criterion 2: two stalled businesses share one request bound', async () => {
      const s = await openSchedules('sol2243a', 100_000);
      await seedSchedules(s.db, 'sol2243b', 100_000);
      const url = new URL(databaseUrlFromEnvironment() ?? '');
      url.pathname = `/${s.db.name}`;
      const holder = new Client(url.toString());
      const lookup = await loginIn(s.db, 'ops_astro_lookup', 'sol2243');
      const keyId = 'test/sol2243@1';
      const handle = createFunctionHandler({
        DATABASE_URL: s.db.appUrl,
        DATABASE_LOOKUP_URL: lookup.url,
        GOTRUE_URL: TEST_ISSUER,
        SERVED_HOST: 'ops.example.test',
        DELEGATION_CREDENTIAL_KEY_ID: keyId,
        DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
        RECOVERY_BUSINESS_KEYS: 'schedules-sol2243a,schedules-sol2243b',
      });
      let response: Promise<Response> | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        await holder.query('begin');
        await holder.query('lock table public.leases in access exclusive mode');
        const started = performance.now();
        response = handle(
          new Request('https://ops.example.test/api/health', {
            headers: { host: 'ops.example.test' },
          }),
        );
        await expect
          .poll(async () => {
            const [row] = await s.db.admin.execute<{ waiting: boolean }>(
              `select exists (select 1 from pg_stat_activity where datname = current_database()
            and usename = $1 and wait_event_type = 'Lock' and query ilike '%leases%') as waiting`,
              [s.db.loginRole],
            );
            return row?.waiting;
          })
          .toBe(true);
        const result = await Promise.race([
          response.then((answer) => answer.status),
          new Promise<'held'>((resolve) => {
            timer = setTimeout(() => resolve('held'), RECOVERY_WAIT_MS + 1_000);
          }),
        ]);
        console.log(
          'Sol criterion 2: two businesses result',
          result,
          'elapsed ms',
          Math.round(performance.now() - started),
        );
        expect(
          result,
          'two per-business lock timeouts must not multiply the request bound',
        ).not.toBe('held');
      } finally {
        clearTimeout(timer);
        await holder.query('rollback');
        await response;
        await handle(
          new Request('https://ops.example.test/api/sign-in', {
            headers: { host: 'ops.example.test' },
          }),
        );
        await holder.end();
        await dropLogins(s.db, [lookup.name]);
      }
    }, 30_000);
  },
);
