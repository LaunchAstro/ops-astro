// SPDX-License-Identifier: AGPL-3.0-only
//
// FR6-RUNNER: the migration runner refuses to apply anything while another
// session is connected to its database.
//
// The supported upgrade is the application stopped. Two ways an upgrade that
// overlaps a live application goes wrong were found in 0030 alone (SOL-R3R-1,
// SOL-R3R2-1), so the rule is enforced by the runner rather than written down
// and hoped for. Each case builds its own database at 0023 (where the durable
// local database stands) or at the head, holds a real second session open,
// and runs the real runner. The CLI case runs `scripts/db-migrate.mjs` as its
// own process, with nothing in its environment but the admin URL.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  applyMigrations,
  MigrationRefused,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  connectAsAdmin,
  connectObserved,
  type AdminConnection,
  type ObservedPool,
} from '../../packages/core-records/src/tenancy/database.ts';
import { syntheticMigration } from '../../packages/core-records/src/tenancy/testing/prefix-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'tenancy/final-r6-runner-guard: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const onDisk = readMigrations('migrations');
const THROUGH_0023 = onDisk.filter((m) => m.version.slice(0, 4) <= '0023');
const PENDING_AFTER_0023 = onDisk
  .filter((m) => m.version.slice(0, 4) > '0023')
  .map((m) => m.version);

function ownerUrl(db: EmptyDatabase): string {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  return url.toString();
}

/** A session held open on the database, and its backend's pid. */
async function hold(url: string): Promise<{ readonly pool: ObservedPool; readonly pid: number }> {
  const pool = connectObserved(url, { source: 'held' });
  const [row] = await pool.betweenTransactions<{ readonly pid: number }>(
    `select pg_backend_pid() as pid`,
  );
  if (row === undefined) throw new Error('no pid for the held session');
  return { pool, pid: row.pid };
}

/** The ledger and everything the migrations make, as one comparable string. */
async function state(db: EmptyDatabase): Promise<string> {
  const [row] = await db.admin.execute<{ readonly state: string }>(
    `select coalesce((select string_agg(version || ':' || checksum, ',' order by version)
                        from ops.schema_migrations), '') || '#' || md5(coalesce(string_agg(x, '|' order by x), '')) as state
       from (
         select 'c:' || n.nspname || '.' || c.relname || ':' || c.relkind::text as x
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
         union all
         select 'p:' || n.nspname || '.' || p.proname || ':' || md5(p.prosrc)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
         union all
         select 't:' || tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text
           from pg_trigger where not tgisinternal
         union all
         select 'k:' || conrelid::regclass::text || '.' || conname
           from pg_constraint c join pg_namespace n on n.oid = c.connamespace
          where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
         union all
         select 'g:' || grantee || ':' || table_schema || '.' || table_name || ':' || privilege_type
           from information_schema.role_table_grants
          where table_schema not like 'pg\\_%' and table_schema <> 'information_schema'
       ) s`,
  );
  return row?.state ?? '';
}

async function lastApplied(db: EmptyDatabase): Promise<string | undefined> {
  const [row] = await db.admin.execute<{ readonly last: string }>(
    `select max(version) as last from ops.schema_migrations`,
  );
  return row?.last;
}

function refusal(error: unknown): MigrationRefused {
  if (!(error instanceof MigrationRefused)) throw error;
  return error;
}

describe.skipIf(serverUrl === undefined)('FR6-RUNNER: the runner refuses while connected', () => {
  let db: EmptyDatabase | undefined;
  const held: ObservedPool[] = [];
  const watchers: AdminConnection[] = [];

  afterEach(async () => {
    await Promise.all([...held, ...watchers].map(async (pool) => await pool.close()));
    held.length = 0;
    watchers.length = 0;
    await db?.drop();
    db = undefined;
  });

  async function at0023(part: string): Promise<EmptyDatabase> {
    const built = await createEmptyDatabase({ part });
    db = built;
    await applyMigrations(built.admin, THROUGH_0023);
    return built;
  }

  it('refuses with an application session held, naming it, and changes nothing', async () => {
    const on = await at0023('fr6app');
    const app = await hold(on.appUrl);
    held.push(app.pool);
    const before = await state(on);

    const refused = refusal(await migrate(on.admin, 'migrations').catch((error: unknown) => error));

    expect(refused.pending).toStrictEqual(PENDING_AFTER_0023);
    expect(refused.applied).toStrictEqual([]);
    expect(refused.sessions.map((s) => ({ pid: s.pid, usename: s.usename }))).toStrictEqual([
      { pid: app.pid, usename: on.loginRole },
    ]);
    expect(refused.message).toContain(`pid ${String(app.pid)} login ${on.loginRole}`);
    expect(refused.message).toContain('Nothing was applied.');
    expect(await state(on)).toBe(before);
    expect(await lastApplied(on)).toBe('0023_delegation_revocation_cause');
  }, 120_000);

  it('refuses with any other client session held, not only the application login', async () => {
    const on = await at0023('fr6other');
    const other = await hold(on.restrictedUrl);
    const owner = await hold(ownerUrl(on));
    held.push(other.pool, owner.pool);
    const before = await state(on);

    const refused = refusal(await migrate(on.admin, 'migrations').catch((error: unknown) => error));

    expect(
      refused.sessions
        .map((s) => ({ pid: s.pid, usename: s.usename }))
        .toSorted((a, b) => a.pid - b.pid),
    ).toStrictEqual(
      [
        { pid: other.pid, usename: on.restrictedRole },
        { pid: owner.pid, usename: new URL(serverUrl ?? '').username },
      ].toSorted((a, b) => a.pid - b.pid),
    );
    expect(await state(on)).toBe(before);
  }, 120_000);

  it('applies every pending migration once the sessions close', async () => {
    const on = await at0023('fr6closed');
    const app = await hold(on.appUrl);
    await expect(migrate(on.admin, 'migrations')).rejects.toBeInstanceOf(MigrationRefused);
    await app.pool.close();

    const outcome = await migrate(on.admin, 'migrations');

    expect(outcome.applied).toStrictEqual(PENDING_AFTER_0023);
    expect(await lastApplied(on)).toBe(onDisk.at(-1)?.version);
  }, 120_000);

  it('passes with the application connected when nothing is pending', async () => {
    const built = await createEmptyDatabase({ part: 'fr6uptodate' });
    db = built;
    await migrate(built.admin, 'migrations');
    const app = await hold(built.appUrl);
    held.push(app.pool);
    const before = await state(built);

    const outcome = await migrate(built.admin, 'migrations');

    expect(outcome).toStrictEqual({
      applied: [],
      alreadyApplied: onDisk.map((m) => m.version),
    });
    expect(await state(built)).toBe(before);
  }, 120_000);

  it('catches a session that connects after the first check, inside the migration, before its commit', async () => {
    const built = await createEmptyDatabase({ part: 'fr6late' });
    db = built;
    await migrate(built.admin, 'migrations');
    const slow = syntheticMigration('9001_fr6_slow', 'select pg_sleep(3)');
    const before = await state(built);
    // The watcher is on the server's own database, so it is not a session on
    // this one and cannot be what the runner refuses.
    const watch = connectAsAdmin(serverUrl ?? '', { source: 'watch' });
    watchers.push(watch);

    const running = applyMigrations(built.admin, [...onDisk, slow]).catch(
      (error: unknown) => error,
    );
    let sleeping = false;
    for (let i = 0; i < 100 && !sleeping; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const rows = await watch.execute<{ readonly n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and state = 'active' and query like '%pg_sleep(3)%'`,
        [built.name],
      );
      sleeping = (rows[0]?.n ?? 0) > 0;
      if (!sleeping) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
    // The runner is inside 9001's transaction: its first check and the one at
    // the start of the transaction have both passed with nobody connected.
    expect(sleeping).toBe(true);
    const late = await hold(built.appUrl);
    held.push(late.pool);

    const refused = refusal(await running);

    expect(refused.pending).toStrictEqual(['9001_fr6_slow']);
    expect(refused.applied).toStrictEqual([]);
    expect(refused.sessions.map((s) => s.pid)).toStrictEqual([late.pid]);
    expect(await state(built)).toBe(before);
  }, 120_000);

  it('refuses through the command line, with nothing in the environment to get round it', async () => {
    const on = await at0023('fr6cli');
    const app = await hold(on.appUrl);
    held.push(app.pool);
    const before = await state(on);

    const run = await promisify(execFile)(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { PATH: process.env['PATH'] ?? '', DATABASE_ADMIN_URL: ownerUrl(on) },
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { readonly code?: number; readonly stderr?: string }) => ({
        code: error.code,
        stderr: error.stderr ?? '',
      }),
    );

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('refusing to apply 8 pending migration(s)');
    expect(run.stderr).toContain(`connected: pid ${String(app.pid)}, login ${on.loginRole}`);
    expect(await state(on)).toBe(before);
  }, 120_000);
});
