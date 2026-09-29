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
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

/** The job as the machine runs it; loaded per test so a missing job fails its own tests only. */
const job = async (): Promise<{
  runBackup: (options: {
    dump: () => Promise<Buffer>;
    storeUrl: string;
    publicKey?: string;
  }) => Promise<Record<string, unknown>>;
  expireBackups: (options: { storeUrl: string }) => Promise<Record<string, unknown>>;
}> => {
  const path = '../../scripts/ops/backup.mjs';
  return await import(/* @vite-ignore */ path);
};

const serverUrl = databaseUrlFromEnvironment();
const BACKUP = 'ops_astro_backup';
const RETENTION = 'ops_astro_backup_retention';
const RESTORE = 'ops_astro_backup_restore';
const SUFFIX: Record<string, string> = { [BACKUP]: 'bk', [RETENTION]: 'rt', [RESTORE]: 'rs' };
const keys = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const drill = async (): Promise<{
  fetchLatest: (storeUrl: string) => Promise<{ takenAt: string; body: Buffer }>;
}> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  return await import(/* @vite-ignore */ path);
};
const seal = async (): Promise<{ openArchive: (sealed: Buffer, privateKey: string) => Buffer }> => {
  const path = '../../scripts/ops/archive-seal.mjs';
  return await import(/* @vite-ignore */ path);
};
const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

if (serverUrl === undefined) {
  console.warn(
    'db/backup-identity: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** A login that is a member of `role` and nothing else, for this database only. */
async function loginIn(db: EmptyDatabase, role: string): Promise<{ url: string; name: string }> {
  const name = `${db.name}_${SUFFIX[role] ?? 'xx'}`;
  const password = randomBytes(18).toString('base64url');
  await db.admin.execute(
    `create role "${name}" login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls noinherit in role ${role}`,
  );
  await db.admin.execute(`grant connect on database "${db.name}" to "${name}"`);
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  url.username = name;
  url.password = password;
  return { url: url.toString(), name };
}

/** One session, so `set role` and `begin` hold for every statement after them. */
class Client {
  readonly #sql: postgres.Sql;
  constructor(url: string) {
    this.#sql = postgres(url, { max: 1, onnotice: () => undefined });
  }
  async query<Row = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const result = await this.#sql.unsafe(text, values as postgres.ParameterOrJSON<never>[]);
    return { rows: [...result] as Row[], rowCount: result.count };
  }
  async end(): Promise<void> {
    await this.#sql.end();
  }
}

async function asRole(url: string, role: string): Promise<Client> {
  const client = new Client(url);
  await client.query(`set role ${role}`);
  return client;
}

/** The SQLSTATE a statement fails with, or 'ok'. Each try is rolled back. */
async function attempt(client: Client, text: string, values: unknown[] = []): Promise<string> {
  await client.query('begin');
  try {
    await client.query(text, values);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('rollback');
  }
}

async function dropLogins(db: EmptyDatabase | undefined, names: string[]): Promise<void> {
  if (db === undefined) return;
  const url = serverUrl ?? '';
  await db.drop();
  const cleanup = new Client(url);
  try {
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop
      await cleanup.query(`drop role if exists "${name}"`);
    }
  } finally {
    await cleanup.end();
  }
}

describe.skipIf(serverUrl === undefined)('S0-3 identity scope', () => {
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

  it('Sol proof, criterion 4: backup identity reads auth data in the source database', async () => {
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
    expect(allowed).toStrictEqual([]);
    expect(await contents()).toBe(before);
  });

  it('holds select on tables the migrations add later, and nothing more', async () => {
    await db.admin.execute('create table public.s03b_later (id integer primary key)');
    const [grants] = await db.admin.execute<{ privileges: string[] }>(
      `select coalesce(array_agg(privilege_type::text order by privilege_type), '{}') as privileges
         from information_schema.role_table_grants
        where grantee = $1 and table_schema = 'public' and table_name = 's03b_later'`,
      [BACKUP],
    );
    expect(grants?.privileges).toStrictEqual(['SELECT']);
    await db.admin.execute('drop table public.s03b_later');
  });
});

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  let store: EmptyDatabase;
  let backupLogin: { url: string; name: string };
  let retentionLogin: { url: string; name: string };
  let restoreLogin: { url: string; name: string };

  async function receipts(): Promise<{ action: string; archive_id: string; bytes: string }[]> {
    return [
      ...(await store.admin.execute<{ action: string; archive_id: string; bytes: string }>(
        'select action, archive_id::text, bytes::text from backups.receipts order by id',
      )),
    ];
  }

  async function archiveIds(): Promise<string[]> {
    return (
      await store.admin.execute<{ id: string }>('select id::text from backups.archives order by id')
    ).map((r) => r.id);
  }

  beforeAll(async () => {
    // The role the store grants to is made by migration 0034 on the source; one
    // cluster holds both, as staging's server does.
    const source = await createFreshDatabase({ part: 's03bsrc' });
    await source.drop();
    store = await createEmptyDatabase({ part: 's03bstore' });
    await store.admin.execute(read('deploy/staging/backup-store.sql'));
    backupLogin = await loginIn(store, BACKUP);
    retentionLogin = await loginIn(store, RETENTION);
    restoreLogin = await loginIn(store, RESTORE);
  }, 120_000);

  afterAll(async () => {
    await dropLogins(
      store,
      [backupLogin?.name, retentionLogin?.name, restoreLogin?.name].filter(
        (n): n is string => n !== undefined,
      ),
    );
  });

  describe('S0-3 identity scope', () => {
    it('adds a backup and is refused every list, read, change or delete on the store', async () => {
      const client = await asRole(backupLogin.url, BACKUP);
      try {
        await client.query('insert into backups.archives (body) values ($1)', [
          Buffer.from('PGDMP made-up'),
        ]);
        const refused: Record<string, string> = {};
        for (const [what, text] of Object.entries({
          list: 'select id, taken_at from backups.archives',
          read: 'select body from backups.archives',
          count: 'select count(*) from backups.archives',
          returning: `insert into backups.archives (body) values ('\\x00') returning id`,
          backdate: `insert into backups.archives (body, taken_at) values ('\\x00', now() - interval '400 days')`,
          change: `update backups.archives set body = '\\x00'`,
          delete: 'delete from backups.archives',
          truncate: 'truncate backups.archives',
          receipts: 'select * from backups.receipts',
          forge: `insert into backups.receipts (action) values ('backup expired')`,
          window: 'update backups.settings set retention_days = 1',
        })) {
          // oxlint-disable-next-line no-await-in-loop
          refused[what] = await attempt(client, text);
        }
        expect(Object.values(refused).every((code) => code === '42501')).toBe(true);
      } finally {
        await client.end();
      }
      const [row] = await store.admin.execute<{ n: number; sha: string }>(
        `select count(*)::int as n, min(sha256) as sha from backups.archives`,
      );
      expect(row?.n).toBe(1);
      expect(row?.sha).toMatch(/^[0-9a-f]{64}$/u);
    });
  });

  describe('S0-3 backup scheduled', () => {
    it('records every run: a recorded backup leaves a receipt, a failed one says only that it failed', async () => {
      const before = (await receipts()).length;
      const { runBackup } = await job();
      const ok = await runBackup({
        dump: async () => Buffer.from('PGDMP made-up nightly'),
        storeUrl: backupLogin.url,
        publicKey: keys.publicKey,
      });
      expect(ok).toMatchObject({ event: 'backup run', outcome: 'recorded' });
      const after = await receipts();
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)).toMatchObject({ action: 'backup recorded', bytes: String(ok['bytes']) });

      const canary = `canary-${randomBytes(8).toString('hex')}`;
      const failed = await runBackup({
        dump: async () => {
          throw new Error(`pg_dump: password ${canary} rejected for ${backupLogin.url}`);
        },
        storeUrl: backupLogin.url,
        publicKey: keys.publicKey,
      });
      expect(failed).toMatchObject({ event: 'backup run', outcome: 'failed', stage: 'dump' });
      expect(JSON.stringify(failed)).not.toContain(canary);
      expect(JSON.stringify(failed)).not.toContain(backupLogin.name);
      expect((await receipts()).length).toBe(before + 1);

      const refusedStore = await runBackup({
        dump: async () => Buffer.from('PGDMP'),
        storeUrl: retentionLogin.url,
        publicKey: keys.publicKey,
      });
      expect(refusedStore).toMatchObject({ outcome: 'failed', stage: 'store' });
      expect(JSON.stringify(refusedStore)).not.toContain(retentionLogin.name);
    });

    it('is scheduled daily on staging, each job under its own identity, with no credential in the definition', () => {
      const jobs = {
        run: read('deploy/staging/ops-astro-staging-backup.plist'),
        expire: read('deploy/staging/ops-astro-staging-backup-expire.plist'),
      };
      const envFiles = new Set<string>();
      for (const [command, plist] of Object.entries(jobs)) {
        expect(plist).toMatch(/<key>Label<\/key>\s*<string>ops-astro-staging-backup/u);
        expect(plist).toMatch(
          /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>\d+<\/integer>/u,
        );
        expect(plist).toContain('<string>scripts/ops/backup.mjs</string>');
        expect(plist).toContain(`<string>${command}</string>`);
        const env = /--env-file=([^<]+)</u.exec(plist)?.[1];
        expect(env).toBeDefined();
        envFiles.add(env ?? '');
        expect(plist).not.toMatch(/postgres(ql)?:\/\/|password|PGPASSWORD|\/Users\//iu);
      }
      expect(envFiles.size).toBe(2);
    });
  });

  describe('S0-3 backup retention', () => {
    it('keeps the window in one place, the store', async () => {
      const [row] = await store.admin.execute<{ n: number; days: number }>(
        'select count(*)::int as n, min(retention_days) as days from backups.settings',
      );
      expect(row?.n).toBe(1);
      expect(row?.days).toBeGreaterThan(0);
      expect(read('scripts/ops/backup.mjs')).not.toMatch(/retention_days\s*=|interval\s*'\d/u);
    });

    it('deletes only a backup past the window, each with a receipt, and cannot delete one inside it', async () => {
      await store.admin.execute(`insert into backups.archives (body) values ('\\x01'), ('\\x02')`);
      const [old] = await store.admin.execute<{ id: string }>(
        `update backups.archives set taken_at = now() - make_interval(days => (select retention_days + 1 from backups.settings))
          where id = (select id from backups.archives where body = '\\x01') returning id::text`,
      );
      const inWindow = (await archiveIds()).filter((id) => id !== old?.id);

      const client = await asRole(retentionLogin.url, RETENTION);
      try {
        expect(await attempt(client, 'select body from backups.archives')).toBe('42501');
        expect(
          await attempt(
            client,
            `update backups.archives set taken_at = now() - interval '999 days'`,
          ),
        ).toBe('42501');
        expect(await attempt(client, `insert into backups.archives (body) values ('\\x03')`)).toBe(
          '42501',
        );
        expect(await attempt(client, 'update backups.settings set retention_days = 1')).toBe(
          '42501',
        );
        expect(await attempt(client, 'truncate backups.archives')).toBe('42501');
        expect(await attempt(client, 'delete from backups.receipts')).toBe('42501');
        await client.query('begin');
        const tried = await client.query(
          'delete from backups.archives where id = any($1::uuid[])',
          [inWindow],
        );
        await client.query('commit');
        expect(tried.rowCount).toBe(0);
      } finally {
        await client.end();
      }
      expect(await archiveIds()).toStrictEqual([...inWindow, old?.id].toSorted());

      const { expireBackups } = await job();
      const receipt = await expireBackups({ storeUrl: retentionLogin.url });
      expect(receipt).toMatchObject({ event: 'backup expired', outcome: 'recorded', count: 1 });
      expect(await archiveIds()).toStrictEqual(inWindow.toSorted());
      const expired = (await receipts()).filter((r) => r.action === 'backup expired');
      expect(expired.map((r) => r.archive_id)).toStrictEqual([old?.id]);
    });
  });

  describe('S0-3 backup encryption', () => {
    it('Sol proof, criterion 12: a read stays logged after the reader rolls back', async () => {
      const { runBackup } = await job();
      const recorded = await runBackup({
        dump: async () => Buffer.from('PGDMP rollback proof'),
        storeUrl: backupLogin.url,
        publicKey: keys.publicKey,
      });
      expect(recorded['outcome']).toBe('recorded');
      const before = (await receipts()).length;
      const reader = postgres(restoreLogin.url, { max: 1 });
      try {
        await expect(
          reader.begin(async (tx) => {
            await tx.unsafe(`set local role ${RESTORE}`);
            const [archive] = await tx`select body from backups.read_latest()`;
            expect(archive?.['body']).toBeInstanceOf(Buffer);
            throw new Error('rollback after access');
          }),
        ).rejects.toThrow('rollback after access');
      } finally {
        await reader.end();
      }
      expect((await receipts()).length).toBe(before + 1);
    });

    it('stores only the sealed artefact, and refuses to store a backup it cannot seal', async () => {
      const { runBackup } = await job();
      const dump = Buffer.from(`PGDMP made-up ${randomBytes(6).toString('hex')}`);
      const ok = await runBackup({
        dump: async () => dump,
        storeUrl: backupLogin.url,
        publicKey: keys.publicKey,
      });
      expect(ok).toMatchObject({ outcome: 'recorded' });
      const [row] = await store.admin.execute<{ body: Buffer }>(
        'select body from backups.archives order by taken_at desc, id desc limit 1',
      );
      expect(row?.body.includes(dump)).toBe(false);
      expect(row?.body.includes(Buffer.from('PGDMP'))).toBe(false);
      expect(
        (await seal()).openArchive(row?.body ?? Buffer.alloc(0), keys.privateKey).equals(dump),
      ).toBe(true);

      const before = await archiveIds();
      const unsealed = await runBackup({ dump: async () => dump, storeUrl: backupLogin.url });
      expect(unsealed).toMatchObject({ outcome: 'failed', stage: 'seal' });
      expect(await archiveIds()).toStrictEqual(before);
    });

    it('lets the restore identity read the newest backup only through the store, logging each read', async () => {
      const [newest] = await store.admin.execute<{ id: string; taken_at: Date }>(
        'select id::text, taken_at from backups.archives order by taken_at desc, id desc limit 1',
      );
      const before = (await receipts()).length;
      const { fetchLatest } = await drill();
      const fetched = await fetchLatest(restoreLogin.url);
      expect(fetched.takenAt).toBe(newest?.taken_at.toISOString());
      const logged = await receipts();
      expect(logged.length).toBe(before + 1);
      expect(logged.at(-1)).toMatchObject({ action: 'backup read', archive_id: newest?.id });
      const [actor] = await store.admin.execute<{ actor: string }>(
        'select actor from backups.receipts order by id desc limit 1',
      );
      expect(actor?.actor).toBe(restoreLogin.name);

      const reader = await asRole(restoreLogin.url, RESTORE);
      try {
        for (const text of [
          'select body from backups.archives',
          'select id from backups.archives',
          `insert into backups.archives (body) values ('\\x01')`,
          'delete from backups.archives',
          'update backups.receipts set actor = actor',
          'select * from backups.settings',
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          expect(await attempt(reader, text), text).toBe('42501');
        }
      } finally {
        await reader.end();
      }
      for (const [login, role] of [
        [backupLogin, BACKUP],
        [retentionLogin, RETENTION],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const other = await asRole(login.url, role);
        try {
          // oxlint-disable-next-line no-await-in-loop
          expect(await attempt(other, 'select * from backups.read_latest()')).toBe('42501');
        } finally {
          // oxlint-disable-next-line no-await-in-loop
          await other.end();
        }
      }
      expect((await receipts()).length).toBe(before + 1);
    });
  });
});
