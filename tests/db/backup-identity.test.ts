// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3b: the backup job and its two identities (ticket S0-3, lines C1 and C11).
//
// `S0-3 identity scope`: on a database migrated to the head, a login holding
// the backup identity takes pg_dump's consistent read of every table (row
// security off, one repeatable-read snapshot), and every insert, update,
// delete, truncate, schema change and product function call it tries is
// refused and changes no row. On the backup store it adds a backup and every
// list, read, change or delete it tries is refused.
// `S0-3 backup retention`: the retention identity deletes a backup past the
// window, with a receipt, and cannot delete one inside it; the window is one
// row in the store.
// `S0-3 backup scheduled`: the staging schedule runs the job daily under each
// identity's own credentials, and every run, recorded or failed, leaves its
// record.
// `S0-3 backup encryption` (S0-3c, line C8), the store's half: the store holds
// only the sealed artefact, and the restore identity reads the newest one only
// through the store's own function, each read leaving a receipt. The seal and
// the drill's half are in tests/ci/restore-drill.test.ts.
//
// The suites share backup-identity.fixture.ts. `S0-3 identity scope` is here
// and in backup-identity-grants.test.ts; the store's suites are in
// backup-store.test.ts, backup-store-drills.test.ts and
// backup-store-encryption.test.ts.

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  serverUrl,
  BACKUP,
  loginIn,
  asRole,
  attempt,
  dropLogins,
  hostReach,
} from './backup-identity.fixture.ts';

/** The job's upsert of the restore challenge (scripts/ops/backup.mjs). */
const UPSERT =
  'insert into ops.restore_challenge (challenge) values ($1) on conflict (one) do update set challenge = excluded.challenge, written_at = now()';
/** What the refusal case's attempts reach on the challenge's table: its one write, with no value. */
const ONE_WRITE: readonly string[] = ['insert into ops.restore_challenge default values: 23502'];

let db: FreshDatabase;
let login: { url: string; name: string };
let tables: { qualified: string; column: string }[];

/** Every table's row count and content hash, read by the owner. */
async function contents(): Promise<string> {
  const parts: string[] = [];
  for (const { qualified } of tables) {
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await db.admin.execute<{ h: string }>(
      `select count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${qualified} t`,
    );
    parts.push(`${qualified}=${row?.h ?? ''}`);
  }
  return parts.join(',');
}

describe.skipIf(serverUrl === undefined)('S0-3 identity scope', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's03b' });
    login = await loginIn(db, BACKUP);
    tables = [
      ...(await db.admin.execute<{ qualified: string; column: string }>(
        `select format('%I.%I', n.nspname, c.relname) as qualified,
                (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum > 0
                   and not a.attisdropped order by a.attnum limit 1)::text as column
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'ops') and c.relkind in ('r', 'p') order by 1`,
      )),
    ];
  }, 120_000);

  afterAll(async () => {
    await dropLogins(
      db,
      [login?.name].filter((n): n is string => n !== undefined),
    );
  });

  identityScopeCases1();
  identityScopeCases2();
  identityScopeCases3();
});

function identityScopeCases1() {
  it('is a role no one logs in as, that owns nothing and reads past row security', async () => {
    const [role] = await db.admin.execute<Record<string, boolean>>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = $1`,
      [BACKUP],
    );
    expect(role).toStrictEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: true,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
    const owned = await db.admin.execute(
      `select 1 from pg_class where relowner = (select oid from pg_roles where rolname = $1)`,
      [BACKUP],
    );
    expect(owned.length).toBe(0);
  });

  it('takes one consistent read of every table with row security off, as pg_dump does', async () => {
    expect(tables.length).toBeGreaterThan(20);
    const client = await asRole(login.url, BACKUP);
    try {
      await client.query('begin isolation level repeatable read read only');
      await client.query('set local row_security = off');
      for (const { qualified } of tables) {
        // oxlint-disable-next-line no-await-in-loop
        await client.query(`select * from ${qualified} limit 1`);
      }
      const [ledger] = (
        await client.query<{ n: number }>('select count(*)::int as n from ops.schema_migrations')
      ).rows;
      expect(ledger?.n).toBeGreaterThan(30);
      await client.query('commit');
    } finally {
      await client.end();
    }
  });
}

function identityScopeCases2() {
  it('backup identity reads auth data in the source database', async () => {
    await db.admin.execute('create schema auth');
    await db.admin.execute(
      'create table auth.users (id integer primary key, marker text not null)',
    );
    await db.admin.execute(
      "insert into auth.users (id, marker) values (1, 'auth-backup-sentinel')",
    );
    const client = await asRole(login.url, BACKUP);
    try {
      const result = await client.query<{ marker: string }>('select marker from auth.users');
      expect(result.rows).toStrictEqual([{ marker: 'auth-backup-sentinel' }]);
    } finally {
      await client.end();
    }
  });
}

function identityScopeCases3() {
  it('is refused every write, schema change and function call, and changes no row', async () => {
    const before = await contents();
    const client = await asRole(login.url, BACKUP);
    const allowed: string[] = [];
    try {
      for (const { qualified, column } of tables) {
        for (const text of [
          `insert into ${qualified} default values`,
          `update ${qualified} set "${column}" = "${column}"`,
          `delete from ${qualified}`,
          `truncate ${qualified}`,
          `alter table ${qualified} add column s03b_added integer`,
          `drop table ${qualified}`,
          `lock table ${qualified} in exclusive mode`,
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          const code = await attempt(client, text);
          if (code !== '42501') allowed.push(`${text}: ${code}`);
        }
      }
      for (const text of [
        'create table public.s03b_new (id integer)',
        'create table ops.s03b_new (id integer)',
        'create function public.s03b_fn() returns integer language sql as $$ select 1 $$',
        'create schema s03b_schema',
        `create temporary table s03b_temp (id integer)`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const code = await attempt(client, text);
        if (code !== '42501') allowed.push(`${text}: ${code}`);
      }
      const functions = (
        await client.query<{
          signature: string;
          executable: boolean;
          name: string;
          types: string[];
        }>(
          `select p.oid::regprocedure::text as signature, format('%I.%I', n.nspname, p.proname) as name,
                  array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality u(t, i)
                         order by i) as types,
                  has_function_privilege(p.oid, 'execute') as executable
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'ops') and p.prokind = 'f'
              and p.prorettype <> 'trigger'::regtype`,
        )
      ).rows;
      expect(functions.length).toBeGreaterThan(0);
      for (const fn of functions) {
        if (fn.executable) allowed.push(`execute ${fn.signature}`);
        // A sub-select, not a literal null: a strict function over constant
        // nulls is folded by the planner and never reaches the privilege check.
        const args = fn.types.map((type: string) => `(select null::${type})`).join(', ');
        // oxlint-disable-next-line no-await-in-loop
        const code = await attempt(client, `select ${fn.name}(${args})`);
        if (code !== '42501') allowed.push(`call ${fn.signature}: ${code}`);
      }
    } finally {
      await client.end();
    }
    // Its one write (REV158K criterion 13): the restore challenge's insert,
    // reached here with no value and refused by the table. It changes no row.
    expect(allowed).toStrictEqual(ONE_WRITE);
    expect(await contents()).toBe(before);
  });

  it('writes one thing: the restore challenge, one row replaced before each dump, of its one shape, that the tenancy role never reads', async () => {
    const client = await asRole(login.url, BACKUP);
    const [first, second] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
    try {
      // The job's own write, as it sends it (bound), then again over it.
      const path = '../../scripts/ops/backup.mjs';
      const { writeRestoreChallenge } = (await import(
        /* @vite-ignore */
        path
      )) as { writeRestoreChallenge: (url: string, c: string, reach: unknown) => Promise<void> };
      await writeRestoreChallenge(login.url, first, hostReach);
      await writeRestoreChallenge(login.url, second, hostReach);
      for (const bad of ['', 'AB'.repeat(32), `${first}'; drop table ops.restore_challenge; --`]) {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(client, UPSERT, [bad])).toBe('23514');
      }
      expect(await attempt(client, 'update ops.restore_challenge set one = true')).toBe('42501');
      expect(await attempt(client, 'delete from ops.restore_challenge')).toBe('42501');
    } finally {
      await client.end();
    }
    const rows = await db.admin.execute<{ challenge: string }>(
      'select challenge from ops.restore_challenge',
    );
    expect([...rows]).toStrictEqual([{ challenge: second }]);
    const [app] = await db.admin.execute<{ reads: boolean }>(
      "select has_table_privilege('ops_astro_app', 'ops.restore_challenge', 'select') as reads",
    );
    expect(app?.reads).toBe(false);
  });

  it('Sol proof, criterion 4: the source backup identity refuses every insert and update', async () => {
    const client = await asRole(login.url, BACKUP);
    try {
      const challenge = randomBytes(32).toString('hex');
      const insert = await attempt(client, UPSERT, [challenge]);
      const update = await attempt(client, 'update ops.restore_challenge set challenge = $1', [
        challenge,
      ]);
      expect({ insert, update }).toStrictEqual({ insert: '42501', update: '42501' });
    } finally {
      await client.end();
    }
  });
}
