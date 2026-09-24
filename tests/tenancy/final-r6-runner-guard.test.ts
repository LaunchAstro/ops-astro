// SPDX-License-Identifier: AGPL-3.0-only
//
// FR6-RUNNER: the migration runner refuses to apply anything while another
// session is connected to its database.
//
// The supported upgrade is the application stopped. Two ways an upgrade that
// overlaps a live application goes wrong were found in 0030 alone (SOL-R3R-1,
// SOL-R3R2-1), so the runner checks for other sessions as a backstop. It is
// not the stop: an idle application that holds no connection passes the
// check (docs/local/DATA.md, "Upgrade"). One run is all or nothing (FR7), and
// a role that cannot read every session is refused. Each case builds its own database at 0023 (where the durable
// local database stands) or at the head, holds a real second session open,
// and runs the real runner. The CLI case runs `scripts/db-migrate.mjs` as its
// own process, with nothing in its environment but the admin URL.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  MigrationRoleCannotSee,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  connectAsAdmin,
  connectObserved,
  type AdminConnection,
  type ObservedPool,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createStatementLog } from '../../packages/core-records/src/tenancy/statements.ts';
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

/** Whether the runner reached `pg_sleep(3)` on this database, polled from outside it. */
async function sleepingOn(watch: AdminConnection, name: string): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const rows = await watch.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = $1 and state = 'active' and query like '%pg_sleep(3)%'`,
      [name],
    );
    if ((rows[0]?.n ?? 0) > 0) return true;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

function refusal(error: unknown): MigrationRefused {
  if (!(error instanceof MigrationRefused)) throw error;
  return error;
}

describe.skipIf(serverUrl === undefined)('FR6-RUNNER: the runner refuses while connected', () => {
  let db: EmptyDatabase | undefined;
  const held: ObservedPool[] = [];
  const watchers: AdminConnection[] = [];
  const extraRoles: string[] = [];

  afterEach(async () => {
    await Promise.all([...held, ...watchers].map(async (pool) => await pool.close()));
    held.length = 0;
    watchers.length = 0;
    await db?.drop();
    db = undefined;
    if (extraRoles.length > 0) {
      const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
      try {
        for (const role of extraRoles.splice(0)) {
          // oxlint-disable-next-line no-await-in-loop
          await server.execute(`drop role if exists "${role}"`);
        }
      } finally {
        await server.close();
      }
    }
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
    const sleeping = await sleepingOn(watch, built.name);
    // The runner is inside 9001's transaction: its first check and the one at
    // the start of the transaction have both passed with nobody connected.
    expect(sleeping).toBe(true);
    const late = await hold(built.appUrl);
    held.push(late.pool);

    const refused = refusal(await running);

    expect(refused.pending).toStrictEqual(['9001_fr6_slow']);
    expect(refused.sessions.map((s) => s.pid)).toStrictEqual([late.pid]);
    expect(await state(built)).toBe(before);
  }, 120_000);

  // SOL-FR6-2: one invocation is all or nothing. The first of two pending
  // migrations has run its statements and written its ledger row when a
  // session arrives during the second; the refusal must leave neither.
  it('leaves neither migration nor ledger row when a session arrives during the second of two', async () => {
    const built = await createEmptyDatabase({ part: 'fr7batch' });
    db = built;
    await migrate(built.admin, 'migrations');
    const first = syntheticMigration('9001_fr7_first', 'create table ops.fr7_first (id int)');
    const second = syntheticMigration('9002_fr7_second', 'select pg_sleep(3)');
    const before = await state(built);
    const watch = connectAsAdmin(serverUrl ?? '', { source: 'watch' });
    watchers.push(watch);

    const running = applyMigrations(built.admin, [...onDisk, first, second]).catch(
      (error: unknown) => error,
    );
    expect(await sleepingOn(watch, built.name)).toBe(true);
    const late = await hold(built.appUrl);
    held.push(late.pool);
    const refused = refusal(await running);

    const [left] = await built.admin.execute<{ readonly first: boolean; readonly table: boolean }>(
      `select exists (select 1 from ops.schema_migrations where version = '9001_fr7_first') as first,
              to_regclass('ops.fr7_first') is not null as table`,
    );
    expect({
      first: left?.first,
      table: left?.table,
      last: await lastApplied(built),
      sessions: refused.sessions.map((s) => s.pid),
    }).toStrictEqual({
      first: false,
      table: false,
      last: onDisk.at(-1)?.version,
      sessions: [late.pid],
    });
    expect(refused.pending).toStrictEqual(['9001_fr7_first', '9002_fr7_second']);
    expect(await state(built)).toBe(before);
  }, 120_000);

  it('leaves the first of two pending migrations out when the second fails', async () => {
    const built = await createEmptyDatabase({ part: 'fr7fails' });
    db = built;
    await migrate(built.admin, 'migrations');
    const before = await state(built);

    await expect(
      applyMigrations(built.admin, [
        ...onDisk,
        syntheticMigration('9001_fr7_first', 'create table ops.fr7_first (id int)'),
        syntheticMigration('9002_fr7_broken', 'select 1 / 0'),
      ]),
    ).rejects.toThrow(
      // R7-RUNTIME-4: the failure says the run rolled back, and to where.
      new RegExp(
        `^migrate: 9002_fr7_broken failed on: select 1 / 0\\. Nothing was applied; the ` +
          `database is still at ${String(onDisk.at(-1)?.version)}\\.$`,
        'u',
      ),
    );

    expect(await lastApplied(built)).toBe(onDisk.at(-1)?.version);
    expect(await state(built)).toBe(before);
  }, 120_000);

  // SOL-FR7-1, SOL-FR9-1: a COMMIT the reader cannot see would end the one
  // transaction after the first file, so the first file and its ledger row
  // would stay when the third fails. It must be refused before anything runs.
  // It hides behind a nested comment, behind `$$` at the end of an
  // identifier, or behind the last `e` of a word read as an E-string prefix.
  it.each([
    ['fr9nested', '/* outer /* inner */ outer */ COMMIT'],
    ['fr10dollar', 'CREATE TABLE ops.fr9_second$$ (id int); /* outer /* inner */ outer */ COMMIT'],
    ['fr10estring', "select name'\\'; commit; --'"],
    // R8-RUNTIME-1: behind a line comment a lone CR ends, one command to the
    // server, so the extended-protocol backstop cannot see it.
    ['fr11cr', 'create table ops.fr9_second (id int);\n-- note\rcommit\nwork'],
    ['fr11estring', "select E'a'\n'\\'' ; commit; --'"],
  ])(
    'refuses a hidden COMMIT (%s) before the first of three files runs',
    async (part, sql) => {
      const built = await createEmptyDatabase({ part });
      db = built;
      await migrate(built.admin, 'migrations');
      const before = await state(built);

      const outcome = await applyMigrations(built.admin, [
        ...onDisk,
        syntheticMigration('9001_fr9_first', 'create table ops.fr9_first (id int)'),
        syntheticMigration('9002_fr9_commit', sql),
        syntheticMigration('9003_fr9_broken', 'select 1 / 0'),
      ]).catch((error: unknown) => error);

      const [left] = await built.admin.execute<{
        readonly first: boolean;
        readonly table: boolean;
      }>(
        `select exists (select 1 from ops.schema_migrations where version like '9%') as first,
              to_regclass('ops.fr9_first') is not null
                or to_regclass('ops."fr9_second$$"') is not null as table`,
      );
      expect({
        message: outcome instanceof Error ? outcome.message : JSON.stringify(outcome),
        first: left?.first,
        table: left?.table,
      }).toStrictEqual({
        message: expect.stringMatching(
          /^migrate: 9002_fr9_commit holds a statement PostgreSQL will not run inside/u,
        ),
        first: false,
        table: false,
      });
      expect(await lastApplied(built)).toBe(onDisk.at(-1)?.version);
      expect(await state(built)).toBe(before);
    },
    120_000,
  );

  // FR10-GUARD part 2, the backstop: whatever the scanner misreads, the runner
  // sends each piece so that PostgreSQL refuses one holding two commands. The
  // piece is built by hand, past the splitter, so the guard reads it as one
  // CREATE TABLE and lets it through.
  it('has PostgreSQL refuse a piece holding two commands, and rolls the run back whole', async () => {
    const built = await createEmptyDatabase({ part: 'fr10backstop' });
    db = built;
    await migrate(built.admin, 'migrations');
    const before = await state(built);

    const outcome = await applyMigrations(built.admin, [
      ...onDisk,
      syntheticMigration('9001_fr10_first', 'create table ops.fr10_first (id int)'),
      {
        version: '9002_fr10_two',
        checksum: 'fr10',
        statements: ['create table ops.fr10_second (id int); commit'],
      },
      syntheticMigration('9003_fr10_broken', 'select 1 / 0'),
    ]).catch((error: unknown) => error);

    const [left] = await built.admin.execute<{ readonly first: boolean; readonly table: boolean }>(
      `select exists (select 1 from ops.schema_migrations where version like '9%') as first,
              to_regclass('ops.fr10_first') is not null
                or to_regclass('ops.fr10_second') is not null as table`,
    );
    expect({
      message: outcome instanceof Error ? outcome.message : JSON.stringify(outcome),
      cause: outcome instanceof Error ? String(outcome.cause) : '',
      first: left?.first,
      table: left?.table,
    }).toStrictEqual({
      message: expect.stringMatching(/^migrate: 9002_fr10_two failed on: .* Nothing was applied;/u),
      cause: expect.stringContaining('cannot insert multiple commands into a prepared statement'),
      first: false,
      table: false,
    });
    expect(await state(built)).toBe(before);
  }, 120_000);

  // R8-AUTHORITY-5, R8-SURFACE-6: the statement after a comment a lone CR ends
  // is sent and runs; a piece that is not only comments and whitespace is
  // sent, so PostgreSQL refuses what it cannot read rather than the runner
  // dropping it.
  it('runs the statement after a lone-CR comment, and sends a piece with no verb', async () => {
    const built = await createEmptyDatabase({ part: 'fr11cr' });
    db = built;
    await migrate(built.admin, 'migrations');

    await applyMigrations(built.admin, [
      ...onDisk,
      syntheticMigration(
        '9001_fr11_both',
        'create table ops.fr11_a (id int);\n-- b follows\rcreate table ops.fr11_b (id int);',
      ),
    ]);
    const [made] = await built.admin.execute<{ readonly b: boolean }>(
      `select to_regclass('ops.fr11_b') is not null as b`,
    );
    expect(made?.b).toBe(true);

    const before = await state(built);
    await expect(
      applyMigrations(built.admin, [
        ...onDisk,
        syntheticMigration(
          '9001_fr11_both',
          'create table ops.fr11_a (id int);\n-- b follows\rcreate table ops.fr11_b (id int);',
        ),
        syntheticMigration('9002_fr11_junk', 'create table ops.fr11_c (id int);  '),
      ]),
    ).rejects.toThrow(/^migrate: 9002_fr11_junk failed on:  \. Nothing was applied;/u);
    expect(await state(built)).toBe(before);
  }, 120_000);

  // SOL-FR11-1: a block comment the file ends inside is PostgreSQL's lexical
  // error (<xc><<EOF>>), so the piece is sent and refused, and the run with it.
  it('refuses a file that ends inside a block comment, and applies nothing', async () => {
    const built = await createEmptyDatabase({ part: 'fr11eof' });
    db = built;
    await migrate(built.admin, 'migrations');
    const before = await state(built);

    const outcome = await applyMigrations(built.admin, [
      ...onDisk,
      syntheticMigration('9001_fr11_open', 'create table ops.fr11_a (id int); /* unfinished'),
    ]).catch((error: unknown) => error);

    expect({
      message: outcome instanceof Error ? outcome.message : JSON.stringify(outcome),
      cause: outcome instanceof Error ? String(outcome.cause) : '',
    }).toStrictEqual({
      message:
        `migrate: 9001_fr11_open failed on: /* unfinished. Nothing was applied; the database ` +
        `is still at ${String(onDisk.at(-1)?.version)}.`,
      cause: expect.stringContaining('unterminated /* comment'),
    });
    expect(await lastApplied(built)).toBe(onDisk.at(-1)?.version);
    expect(await state(built)).toBe(before);
  }, 120_000);

  // R8-AUTHORITY-4: the version a failed run is still at comes from the
  // ledger, not from the list the caller passed.
  it('names the version the ledger is at when the caller passes a partial list', async () => {
    const built = await at0023('fr11partial');
    await expect(
      applyMigrations(built.admin, [syntheticMigration('9002_fr11_fails', 'select 1 / 0')]),
    ).rejects.toThrow(
      new RegExp(
        `^migrate: 9002_fr11_fails failed on: select 1 / 0\\. Nothing was applied; the ` +
          `database is still at ${String(THROUGH_0023.at(-1)?.version)}\\.$`,
        'u',
      ),
    );
  }, 120_000);

  // R8-RUNTIME-8: a value ADD VALUE adds can be used later in the same run
  // only when the enum type was created in that run too, as on a fresh
  // install. On an upgrade the type was committed earlier, and the use fails.
  it('lets a same-run use of an added enum value pass on a fresh install and fail on upgrade', async () => {
    const create = syntheticMigration('9001_fr11_enum', "create type ops.fr11_k as enum ('a')");
    const add = syntheticMigration('9002_fr11_add', "alter type ops.fr11_k add value 'b'");
    const use = syntheticMigration('9003_fr11_use', "select 'b'::ops.fr11_k");

    const fresh = await createEmptyDatabase({ part: 'fr11enumfresh' });
    db = fresh;
    await expect(
      applyMigrations(fresh.admin, [...onDisk, create, add, use]),
    ).resolves.toMatchObject({
      applied: expect.arrayContaining(['9003_fr11_use']),
    });
    await fresh.drop();
    db = undefined;

    const upgraded = await createEmptyDatabase({ part: 'fr11enumup' });
    db = upgraded;
    await applyMigrations(upgraded.admin, [...onDisk, create]);
    const outcome = await applyMigrations(upgraded.admin, [...onDisk, create, add, use]).catch(
      (error: unknown) => error,
    );
    expect({
      message: outcome instanceof Error ? outcome.message : JSON.stringify(outcome),
      cause: outcome instanceof Error ? String(outcome.cause) : '',
    }).toStrictEqual({
      message: `migrate: 9003_fr11_use failed on: select 'b'::ops.fr11_k. Nothing was applied; the database is still at 9001_fr11_enum.`,
      cause: expect.stringContaining('unsafe use of new value "b" of enum type'),
    });
    expect(await lastApplied(upgraded)).toBe('9001_fr11_enum');
  }, 180_000);

  // The tripwire: a statement that ends the run's transaction, whatever the
  // guard made of it, stops the run at once, and the error does not claim
  // that nothing was applied. The connection turns one marked statement into
  // COMMIT, standing for any misreading still to be found.
  it('stops at once when a statement ends the run, and says earlier work may be committed', async () => {
    const built = await createEmptyDatabase({ part: 'fr11trip' });
    db = built;
    await migrate(built.admin, 'migrations');
    const marker = 'select 1 /* fr11: the server ends the transaction here */';
    const ending: AdminConnection = {
      ...built.admin,
      transaction: async (body, options) =>
        await built.admin.transaction(
          async (execute) =>
            await body(
              async (text, parameters) =>
                await execute(text === marker ? 'commit' : text, parameters),
            ),
          options,
        ),
    };

    const outcome = await applyMigrations(ending, [
      ...onDisk,
      syntheticMigration('9001_fr11_first', 'create table ops.fr11_first (id int)'),
      syntheticMigration('9002_fr11_ends', `create table ops.fr11_second (id int); ${marker}`),
      syntheticMigration('9003_fr11_after', 'create table ops.fr11_third (id int)'),
    ]).catch((error: unknown) => error);

    const [left] = await built.admin.execute<{
      readonly first: boolean;
      readonly second: boolean;
      readonly third: boolean;
    }>(
      `select to_regclass('ops.fr11_first') is not null as first,
              to_regclass('ops.fr11_second') is not null as second,
              to_regclass('ops.fr11_third') is not null as third`,
    );
    expect({
      message: outcome instanceof Error ? outcome.message : JSON.stringify(outcome),
      ...left,
    }).toStrictEqual({
      message:
        `migrate: 9002_fr11_ends ended the run's transaction on: ${marker}. The run stopped ` +
        `there. Work before it in this run may be committed, so read ops.schema_migrations ` +
        `and the schema before running again.`,
      first: true,
      second: true,
      third: false,
    });
  }, 120_000);

  // R6-AUTHORITY-2: a role that is neither superuser nor in pg_read_all_stats
  // sees other roles' sessions with a null backend_type, so a predicate on it
  // would see nobody. The runner must refuse rather than find the room empty.
  it('refuses when its role cannot read every session, rather than seeing nobody', async () => {
    const built = await createEmptyDatabase({ part: 'fr7blind' });
    db = built;
    await migrate(built.admin, 'migrations');
    const blind = `${built.name}_mig`;
    const password = randomBytes(24).toString('base64url');
    await built.admin.execute(
      `create role "${blind}" login password '${password}' nosuperuser createrole`,
    );
    extraRoles.push(blind);
    await built.admin.execute(`grant usage on schema ops to "${blind}"`);
    await built.admin.execute(`grant select, insert on ops.schema_migrations to "${blind}"`);
    const url = new URL(ownerUrl(built));
    url.username = blind;
    url.password = password;
    const runner = connectAsAdmin(url.toString(), { source: 'migration' });
    watchers.push(runner);
    const app = await hold(built.appUrl);
    held.push(app.pool);
    const before = await state(built);

    const outcome = await applyMigrations(runner, [
      ...onDisk,
      syntheticMigration('9001_fr7_blind', 'select 1'),
    ]).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(MigrationRoleCannotSee);
    expect(outcome instanceof Error ? outcome.message : JSON.stringify(outcome)).toMatch(
      /cannot read every session/u,
    );
    expect(await state(built)).toBe(before);

    // The control: with pg_read_all_stats the same role sees the session and
    // the connection check names it, so the grant the refusal asks for is enough.
    await built.admin.execute(`grant pg_read_all_stats to "${blind}"`);
    const seen = refusal(
      await applyMigrations(runner, [
        ...onDisk,
        syntheticMigration('9001_fr7_blind', 'select 1'),
      ]).catch((error: unknown) => error),
    );
    // The harness's own owner session is on this database too, and is named with it.
    expect(seen.sessions.map((s) => s.pid)).toContain(app.pid);
    expect(await state(built)).toBe(before);
  }, 120_000);

  // R7-THERMO-9: the CLI reports the blind-role refusal and exits 2, naming
  // the role and the grant, rather than crashing with exit 1.
  it('refuses a role that cannot read every session through the command line', async () => {
    const on = await at0023('fr10blindcli');
    const blind = `${on.name}_mig`;
    const password = randomBytes(24).toString('base64url');
    await on.admin.execute(
      `create role "${blind}" login password '${password}' nosuperuser createrole`,
    );
    extraRoles.push(blind);
    await on.admin.execute(`grant usage on schema ops to "${blind}"`);
    await on.admin.execute(`grant select, insert on ops.schema_migrations to "${blind}"`);
    const url = new URL(ownerUrl(on));
    url.username = blind;
    url.password = password;
    const before = await state(on);

    const run = await promisify(execFile)(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { PATH: process.env['PATH'] ?? '', DATABASE_ADMIN_URL: url.toString() },
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { readonly code?: number; readonly stderr?: string }) => ({
        code: error.code,
        stderr: error.stderr ?? '',
      }),
    );

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      `db-migrate: migrate: refusing to apply ${String(PENDING_AFTER_0023.length)} pending migration(s)`,
    );
    expect(run.stderr).toContain(`the role ${blind} cannot read every session`);
    expect(run.stderr).toContain(`grant ${blind} pg_read_all_stats`);
    expect(await state(on)).toBe(before);
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
    expect(run.stderr).toContain(
      `refusing to apply ${String(PENDING_AFTER_0023.length)} pending migration(s)`,
    );
    expect(run.stderr).toContain(`connected: pid ${String(app.pid)}, login ${on.loginRole}`);
    expect(await state(on)).toBe(before);
  }, 120_000);
});

// The run is one transaction, so a file holding a statement PostgreSQL will not
// run inside one, or one that would end it, is refused before the runner so
// much as reads the ledger. The connection below throws on any use.
describe('FR7-RUNNER: a statement the one transaction cannot hold is refused first', () => {
  const untouched: AdminConnection = {
    log: createStatementLog(),
    execute: async () => await Promise.reject(new Error('the runner touched the database')),
    transaction: async () => await Promise.reject(new Error('the runner touched the database')),
    close: async () => {},
  };

  it.each([
    ['create index concurrently i on public.t (a)'],
    ['CREATE UNIQUE INDEX\n  CONCURRENTLY i ON public.t (a)'],
    ['drop index concurrently i'],
    ['reindex index concurrently i'],
    ['vacuum public.t'],
    ['create database other'],
    ['alter system set work_mem = 1'],
    ['-- a comment first\ncommit'],
    ['/* and another */ begin'],
    ['rollback'],
    // SOL-FR7-1: block comments nest, so this is one comment and then COMMIT.
    ['/* outer /* inner */ outer */ COMMIT'],
    // SOL-FR7-2, and the rest of PostgreSQL 18's PreventInTransactionBlock
    // callers. REINDEX of a partitioned table or index, and CLUSTER of a
    // partitioned table, are refused inside one too, and the text cannot say
    // whether a relation is partitioned, so every REINDEX and CLUSTER is.
    ['discard all'],
    ['cluster'],
    ['cluster ops.partitioned using partitioned_a'],
    ['reindex schema ops'],
    ['reindex index ops.partitioned_a'],
    ['alter database other set tablespace pg_default'],
    ['alter table ops.partitioned detach partition ops.part1 concurrently'],
    ['alter subscription s refresh publication'],
    // SOL-FR9-1: `$$` after an identifier is part of it, so neither a quote
    // nor the end of the file hides what follows.
    ['CREATE TABLE ops.fr9_second$$ (id int); /* outer /* inner */ outer */ COMMIT'],
    ['ALTER TABLE ops.t$$ DETACH PARTITION ops.p CONCURRENTLY'],
    // R7-RUNTIME-1's form: `$a$` inside two identifiers read as one quote.
    ['create table ops.x$a$ (id int); commit; create table ops.y$a$ (id int)'],
    // The same boundary for E'': the e of `name` does not open an escape string.
    ["select name'\\'; commit; --'"],
    // R8-RUNTIME-1, R8-SURFACE-6: a lone CR ends a line comment, so the server
    // reads `commit work` as the whole piece.
    ['-- x\rcommit\nwork'],
    ['create table ops.t (id int);\n-- x\rcommit\nwork'],
    ['-- note\r; commit\nwork'],
    ['select 1 -- c\r; commit'],
    ['-- x\rrollback\nwork'],
    // R8-THERMO-7: a continued E string keeps its escapes.
    ["select E'a'\n'\\'' ; commit; --'"],
    ["select E'a' -- c\n'\\'' ; commit; --'"],
  ])('refuses %j and touches nothing', async (statement) => {
    await expect(
      applyMigrations(untouched, [
        syntheticMigration('0001_fine', 'create table ops.fine (id int)'),
        syntheticMigration('0002_outside', statement),
      ]),
    ).rejects.toThrow(/^migrate: 0002_outside holds a statement PostgreSQL will not run inside/u);
  });

  // Past the guard, the runner's first act is reading the ledger, which this
  // connection refuses: that error, and not the guard's, is the pass. A word
  // inside a comment or a quoted run is not a word of the statement.
  it.each([
    ['create index i on ops.t (a) -- not concurrently'],
    ["comment on table ops.t is 'built once, not concurrently'"],
    ["alter type ops.kind rename value 'a' to 'b' /* add value later */"],
    ["create function ops.f() returns void language sql as $$ select 'commit' $$"],
    ['analyze ops.t'],
    // R7-SURFACE-6: PostgreSQL 12 and later run ADD VALUE inside a transaction
    // block. A later use in the same run fails and rolls the run back whole
    // when the type was committed before the run (every upgrade), and
    // succeeds when the run created the type too (a fresh install): see the
    // live case in FR6-RUNNER.
    ["alter type ops.kind add value 'x'"],
  ])('passes %j', async (statement) => {
    await expect(
      applyMigrations(untouched, [syntheticMigration('0001_fine', statement)]),
    ).rejects.toThrow('the runner touched the database');
  });

  it('refuses none of the files on disk, 0001 to the last', async () => {
    await expect(applyMigrations(untouched, onDisk)).rejects.toThrow(
      'the runner touched the database',
    );
  });
});
