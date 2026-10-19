// SPDX-License-Identifier: AGPL-3.0-only
//
// Limits on the runner's lock-first rule (#1984), from the cross-vendor review
// of #2007 (findings S2007-1, S2007-2 and S2007-3), copied with their
// assertions unchanged. A session queued behind the run's locks counts: one
// whose transaction read an old function definition and holds an advisory
// lock, and one single statement whose function read the old definition
// before it queued, each still refuse the run. And the locks stay inside `ops`
// and `public`: locking a public table does not reach an inheritance child in
// `auth`.

import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  applyMigrations,
  MigrationRefused,
} from '../../packages/core-records/src/tenancy/migrate.ts';

const serverUrl = databaseUrlFromEnvironment();

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    // oxlint-disable-next-line no-await-in-loop -- poll until the condition holds
    if (await check()) return;
    // oxlint-disable-next-line no-await-in-loop -- the next poll follows this pause
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('synchronisation condition not reached');
}
async function fixture(part: string) {
  const db = await createEmptyDatabase({ part });
  await db.admin.execute('create schema ops');
  await db.admin.execute(
    'create table ops.schema_migrations (version text primary key, checksum text not null)',
  );
  await db.admin.execute('create table public.sol_target (id int)');
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  const watch = connectAsAdmin(serverUrl ?? '');
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  return { db, watch, sql };
}

describe.skipIf(serverUrl === undefined)('the runner lock-first rule', () => {
  it('refuses a queued reader whose transaction read an old function and holds an advisory lock', async () => {
    const { db, watch, sql } = await fixture('sol2007busy');
    let running: Promise<unknown> | undefined;
    try {
      await db.admin.execute(
        "create function public.sol_version() returns text language sql as $$select 'old'::text$$",
      );
      running = applyMigrations(db.admin, [
        {
          version: '9001_sol',
          checksum: 'sol',
          statements: [
            "create or replace function public.sol_version() returns text language sql as $$select 'new'::text$$",
            'select pg_sleep(3)',
          ],
        },
      ]).catch((error) => error);
      await until(async () => {
        const [r] = await watch.execute<{ sleeping: boolean }>(
          "select exists(select 1 from pg_stat_activity where datname=$1 and wait_event='PgSleep') as sleeping",
          [db.name],
        );
        return r?.sleeping === true;
      });
      await sql.unsafe('begin');
      const [old] = await sql.unsafe(
        'select public.sol_version() as value, pg_backend_pid() as pid',
      );
      expect(old?.['value']).toBe('old');
      await sql.unsafe('select pg_advisory_xact_lock(20071984)');
      let readFinished = false;
      const reading = sql.unsafe('select * from public.sol_target').then(
        (rows) => {
          readFinished = true;
          return rows;
        },
        (error: unknown) => {
          readFinished = true;
          return error;
        },
      );
      await until(async () => {
        const [r] = await watch.execute<{ waiting: boolean }>(
          "select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') as waiting",
          [old?.['pid']],
        );
        return readFinished || r?.waiting === true;
      });
      const result = await running;
      await reading;
      await sql.unsafe('rollback');
      const [ledger] = await db.admin.execute<{ n: number }>(
        'select count(*)::int as n from ops.schema_migrations',
      );
      expect({ refused: result instanceof MigrationRefused, ledger: ledger?.n }).toEqual({
        refused: true,
        ledger: 0,
      });
    } finally {
      await running;
      await sql.end({ timeout: 1 });
      await watch.close();
      await db.drop();
    }
  }, 15000);

  it('refuses a single queued statement that already read the old function', async () => {
    const { db, watch, sql } = await fixture('sol2007single');
    let running: Promise<unknown> | undefined;
    try {
      await db.admin.execute(
        "create function public.sol_version() returns text language sql as $$select 'old'::text$$",
      );
      await db.admin.execute(
        'create function public.sol_read() returns text language plpgsql as $$declare v text; begin v := public.sol_version(); perform * from public.sol_target; return v; end$$',
      );
      running = applyMigrations(db.admin, [
        {
          version: '9001_sol',
          checksum: 'sol',
          statements: [
            "create or replace function public.sol_version() returns text language sql as $$select 'new'::text$$",
            'select pg_sleep(3)',
          ],
        },
      ]).catch((error) => error);
      await until(async () => {
        const [r] = await watch.execute<{ sleeping: boolean }>(
          "select exists(select 1 from pg_stat_activity where datname=$1 and wait_event='PgSleep') as sleeping",
          [db.name],
        );
        return r?.sleeping === true;
      });
      const [session] = await sql.unsafe('select pg_backend_pid() as pid');
      let readFinished = false;
      const reading = sql.unsafe('select public.sol_read() as value').then(
        (rows) => {
          readFinished = true;
          return rows;
        },
        (error: unknown) => {
          readFinished = true;
          return error;
        },
      );
      await until(async () => {
        const [r] = await watch.execute<{ waiting: boolean }>(
          "select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') as waiting",
          [session?.['pid']],
        );
        return readFinished || r?.waiting === true;
      });
      const [observed] = await watch.execute<{
        waiting: boolean;
        same_start: boolean;
        other_locks: number;
      }>(
        "select a.wait_event_type = 'Lock' as waiting, a.xact_start = a.query_start as same_start, (select count(*)::int from pg_locks l where l.pid=a.pid and l.granted and l.locktype <> 'virtualxid') as other_locks from pg_stat_activity a where a.pid=$1",
        [session?.['pid']],
      );
      expect(observed).toMatchObject({ waiting: true, same_start: true, other_locks: 0 });
      const result = await running;
      const resultRead = (await reading) as readonly { readonly value?: unknown }[];
      expect(resultRead[0]?.value).toBe('old');
      const [ledger] = await db.admin.execute<{ n: number }>(
        'select count(*)::int as n from ops.schema_migrations',
      );
      expect({ refused: result instanceof MigrationRefused, ledger: ledger?.n }).toEqual({
        refused: true,
        ledger: 0,
      });
    } finally {
      await running;
      await sql.end({ timeout: 1 });
      await watch.close();
      await db.drop();
    }
  }, 15000);

  it('does not lock an inheritance child in auth when it locks the public parent', async () => {
    const { db, watch, sql } = await fixture('sol2007scope');
    let running: Promise<unknown> | undefined;
    try {
      await db.admin.execute('create schema auth');
      await db.admin.execute('create table auth.sol_child () inherits (public.sol_target)');
      running = applyMigrations(db.admin, [
        { version: '9001_sol', checksum: 'sol', statements: ['select pg_sleep(3)'] },
      ]).catch((error) => error);
      await until(async () => {
        const [r] = await watch.execute<{ sleeping: boolean }>(
          "select exists(select 1 from pg_stat_activity where datname=$1 and wait_event='PgSleep') as sleeping",
          [db.name],
        );
        return r?.sleeping === true;
      });
      const [locks] = await sql.unsafe(
        "select count(*)::int as n from pg_locks where relation='auth.sol_child'::regclass and mode='AccessExclusiveLock' and granted",
      );
      await sql.end({ timeout: 1 });
      const result = await running;
      expect(result).toMatchObject({ applied: ['9001_sol'] });
      expect(locks?.['n']).toBe(0);
    } finally {
      await running;
      await sql.end({ timeout: 1 });
      await watch.close();
      await db.drop();
    }
  }, 15000);
});
