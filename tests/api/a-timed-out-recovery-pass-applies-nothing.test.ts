// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client, dropLogins, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, openSchedules, seedSchedules } from '../runtime/schedules-harness.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a timed-out reconciliation pass',
  () => {
    it('Sol proof, criterion 2: a timed-out pass applies nothing', async () => {
      const s = await openSchedules('sol2243rollback', 100_000);
      const other = await seedSchedules(s.db, 'sol2243other', 100_000);
      const work = await liveWork(s, 'Synthetic rollback proof', 1_000);
      await s.db.admin.execute(
        "update public.leases set expires_at = now() - interval '1 minute' where id = $1",
        [work.picked['leaseId']],
      );
      const snapshot = async () => {
        const result: Record<string, unknown> = {};
        for (const table of [
          'budget_caps',
          'reservations',
          'task_envelopes',
          'leases',
          'attempts',
        ]) {
          result[table] = await s.db.admin.execute(
            `select to_jsonb(t) as row from public.${table} t order by business_id, id`,
          );
        }
        return result;
      };
      const before = await snapshot();
      expect(
        await s.db.app.withBusiness(
          s.business,
          async (tx) =>
            await tx.query('select id from public.budget_caps where business_id = $1', [
              other.business,
            ]),
        ),
      ).toEqual([]);
      await s.db.admin.execute(
        `create function public.sol2243_block() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(22432243); return new; end $$`,
      );
      await s.db.admin.execute(
        `create trigger sol2243_block after update on public.reservations for each row execute function public.sol2243_block()`,
      );
      const url = new URL(databaseUrlFromEnvironment() ?? '');
      url.pathname = `/${s.db.name}`;
      const holder = new Client(url.toString());
      const lookup = await loginIn(s.db, 'ops_astro_lookup', 'sol2243rollback');
      const keyId = 'test/sol2243rollback@1';
      const handle = createFunctionHandler({
        DATABASE_URL: s.db.appUrl,
        DATABASE_LOOKUP_URL: lookup.url,
        GOTRUE_URL: TEST_ISSUER,
        SERVED_HOST: 'ops.example.test',
        DELEGATION_CREDENTIAL_KEY_ID: keyId,
        DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
        RECOVERY_BUSINESS_KEYS: 'schedules-sol2243rollback',
      });
      let response: Promise<Response> | undefined;
      try {
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(22432243)');
        response = handle(
          new Request('https://ops.example.test/api/health', {
            headers: { host: 'ops.example.test' },
          }),
        );
        await expect
          .poll(async () => {
            const [row] = await s.db.admin.execute<{ waiting: boolean }>(
              `select exists (select 1 from pg_stat_activity where datname = current_database()
            and usename = $1 and wait_event_type = 'Lock' and query ilike '%update public.reservations%') as waiting`,
              [s.db.loginRole],
            );
            return row?.waiting;
          })
          .toBe(true);
        expect((await response).status).toBe(200);
        const [row] = await s.db.admin.execute<{ open: number }>(
          `select count(*)::int as open from pg_stat_activity where datname = current_database() and usename = $1 and xact_start is not null`,
          [s.db.loginRole],
        );
        expect(row?.open).toBe(0);
        expect(await snapshot()).toEqual(before);
      } finally {
        await holder.query('rollback');
        await response;
        await holder.end();
        await dropLogins(s.db, [lookup.name]);
      }
    }, 30_000);
  },
);
