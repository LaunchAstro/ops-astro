// SPDX-License-Identifier: AGPL-3.0-only
//
// `T4 worker role` (T4b2, spike RN-04): the worker role `ops_astro_worker`
// (migrations/0008_agent_authority.sql) reaches no business's rows, proved
// three ways against a fully migrated database.
//
//   - Catalogue: the worker role holds no privilege on any table, view,
//     sequence or function in the installation's schemas, security-definer
//     functions included, and no CREATE or USAGE on `ops`; PUBLIC may execute
//     no function there. The mutation is checked here, because behaviour alone
//     does not go red on a table under row-level security: with SELECT granted
//     on `reservations`, the worker is still refused 42501, by the policy's
//     own function rather than by the table.
//   - Behaviour: a login the test creates as a member of the worker role is
//     refused (42501) on every table, every sequence and every function it can
//     call, beside the application login, which reads the same tables as its
//     positive control.
//   - Structure: the worker has no database connection. The shipped worker's
//     module graph imports no Postgres driver; `tests/worker/worker-boundary.test.ts`
//     walks it and plants the import, and it runs in the same conformance run.
//
// Known and stated, not findings: CONNECT and TEMPORARY on the database and
// USAGE on schema `public` are granted to PUBLIC by Postgres itself, and USAGE
// on `public` cannot be taken from one role.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const WORKER = 'ops_astro_worker';
const OWN = `n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'`;
const serverUrl = databaseUrlFromEnvironment();

/** Every privilege `role` holds on the installation's own objects, one line each. */
async function catalogue(admin: AdminConnection, role: string): Promise<string[]> {
  const rows = await admin.execute<{ line: string }>(
    `select n.nspname || '.' || c.relname || ' ' || p as line
       from pg_class c join pg_namespace n on n.oid = c.relnamespace,
            unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where ${OWN} and c.relkind in ('r','p','v','m','f') and has_table_privilege($1, c.oid, p)
     union all
     select n.nspname || '.' || c.relname || ' ' || p
       from pg_class c join pg_namespace n on n.oid = c.relnamespace,
            unnest(array['USAGE','SELECT','UPDATE']) p
      where ${OWN} and c.relkind = 'S' and has_sequence_privilege($1, c.oid, p)
     union all
     select p.oid::regprocedure::text || ' EXECUTE' || case when p.prosecdef then ' (definer)' else '' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${OWN} and has_function_privilege($1, p.oid, 'EXECUTE')
     union all
     select 'schema ops ' || p from unnest(array['CREATE','USAGE']) p
      where has_schema_privilege($1, 'ops', p)
     union all
     select 'schema public CREATE' where has_schema_privilege($1, 'public', 'CREATE')
     order by 1`,
    [role],
  );
  return rows.map((row) => row.line);
}

/** One statement per table, sequence and callable function, as `role` would send them. */
async function statements(admin: AdminConnection): Promise<{ what: string; sql: string }[]> {
  const relations = await admin.execute<{ name: string; kind: string }>(
    `select format('%I.%I', n.nspname, c.relname) as name, c.relkind::text as kind
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where ${OWN} and c.relkind in ('r','p','v','m','f','S') order by 1`,
  );
  const functions = await admin.execute<{ name: string; call: string }>(
    `select p.oid::regprocedure::text as name,
            format('select %I.%I(%s)', n.nspname, p.proname,
              coalesce((select string_agg('null::' || format_type(t, null), ', ')
                          from unnest(p.proargtypes) t), '')) as call
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${OWN} and p.prokind = 'f'
        and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      order by 1`,
  );
  return [
    ...relations.map((relation) => ({
      what: relation.name,
      sql:
        relation.kind === 'S'
          ? `select nextval('${relation.name}')`
          : `select 1 from ${relation.name} limit 0`,
    })),
    ...functions.map((routine) => ({ what: routine.name, sql: routine.call })),
  ];
}

async function codeOf(connection: AdminConnection, sql: string): Promise<string> {
  try {
    await connection.execute(sql);
    return 'ran';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? error);
  }
}

// eslint-disable-next-line max-lines-per-function -- one database, one worker login, three parts
describe.skipIf(serverUrl === undefined)('T4 worker role', () => {
  let db: FreshDatabase;
  let admin: AdminConnection;
  let worker: AdminConnection;
  let application: AdminConnection;
  const login = `t4_worker_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 't4_worker_role' });
    admin = db.admin;
    const password = randomUUID();
    await admin.execute(`create role ${login} login password '${password}' in role ${WORKER}`);
    const url = new URL(db.appUrl);
    url.username = login;
    url.password = password;
    worker = connectAsAdmin(url.toString(), { source: 't4-worker-role' });
    application = connectAsAdmin(db.appUrl, { source: 't4-worker-role' });
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await application?.close();
    await admin?.execute(`drop role if exists ${login}`);
    await db?.drop();
  });

  it('catalogue: the worker role holds nothing, and PUBLIC may execute no function', async () => {
    const [membership] = await admin.execute<{ member: boolean }>(
      `select pg_has_role($1, $2, 'MEMBER') as member`,
      [login, WORKER],
    );
    expect(membership?.member).toBe(true);
    expect(await catalogue(admin, WORKER)).toStrictEqual([]);
    expect(await catalogue(admin, login)).toStrictEqual([]);
    const executable = (await catalogue(admin, 'public')).filter((line) =>
      line.includes('EXECUTE'),
    );
    expect(executable).toStrictEqual([]);
  });

  it('catalogue mutation: a SELECT granted on a table under row security is found', async () => {
    await admin.execute(`grant select on public.reservations to ${WORKER}`);
    try {
      expect(await catalogue(admin, WORKER)).toStrictEqual(['public.reservations SELECT']);
      // Behaviour alone stays green under this mutation: the SELECT is still
      // refused 42501, now by the row policy's own function, not by the table.
      expect(await codeOf(worker, 'select 1 from public.reservations')).toBe('42501');
    } finally {
      await admin.execute(`revoke select on public.reservations from ${WORKER}`);
    }
    expect(await catalogue(admin, WORKER)).toStrictEqual([]);
  });

  it('behaviour: a worker login is refused every table, sequence and function; the application reads the tables', async () => {
    const all = await statements(admin);
    expect(all.length).toBeGreaterThan(40);
    const reached: string[] = [];
    for (const statement of all) {
      // eslint-disable-next-line no-await-in-loop -- one statement at a time, on one login
      const code = await codeOf(worker, statement.sql);
      if (code !== '42501') reached.push(`${statement.what}: ${code}`);
    }
    expect(reached).toStrictEqual([]);
    const tables = all.filter((statement) => statement.sql.startsWith('select 1 from public.'));
    const refusedToApplication: string[] = [];
    for (const table of tables) {
      // eslint-disable-next-line no-await-in-loop -- the positive control, one table at a time
      const code = await codeOf(application, table.sql);
      if (code === '42501') refusedToApplication.push(table.what);
    }
    expect(tables.length - refusedToApplication.length).toBeGreaterThan(20);
    for (const table of ['public.records', 'public.reservations', 'public.run_events']) {
      expect(tables.map((statement) => statement.what)).toContain(table);
      expect(refusedToApplication).not.toContain(table);
    }
  });
});
