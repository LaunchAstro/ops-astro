// SPDX-License-Identifier: AGPL-3.0-only
//
// G2, the business lookup login (the Vercel re-plan, section 6; the
// orchestrator's ruling G2 (a)). The function on Vercel holds no admin login,
// so the one read that precedes tenancy, a business key to its id
// (`createBusinessResolver`, apps/api/server.ts), runs as `ops_astro_lookup`
// (migration 0046): past row security, `id` and `key` of `public.businesses`,
// and nothing else. Asked of a login in the role on the acceptance world, two
// businesses with their people and a journey walked to a handback:
// - it reads every business's id and key, and no other column of businesses;
// - every other table is refused a select, an insert, an update and a delete,
//   and businesses every write, each 42501;
// - the three crossings are refused 42501 over rows that exist: another
//   business's records, another record in the same business, another person;
// - the served resolver answers a key through it and nothing else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { walkTheJourney } from '../acceptance/restart-harness.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { asRole, attempt, Client, loginIn } from './backup-identity.fixture.ts';

const LOOKUP = 'ops_astro_lookup';

let world: World;
let login: { url: string; name: string };
let lookup: Client;
let tables: readonly { qualified: string; column: string }[];

describe.skipIf(serverUrl === undefined)('G2 the business lookup login', () => {
  beforeAll(async () => {
    world = await createWorld('g2lk');
    await walkTheJourney(world);
    login = await loginIn(world.db, LOOKUP, 'lk');
    lookup = await asRole(login.url, LOOKUP);
    tables = await world.db.admin.execute<{ qualified: string; column: string }>(
      `select format('%I.%I', n.nspname, c.relname) as qualified,
              (select format('%I', a.attname) from pg_attribute a where a.attrelid = c.oid
                 and a.attnum > 0 and not a.attisdropped order by a.attnum limit 1) as column
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'ops') and c.relkind in ('r', 'p') order by 1`,
    );
  }, 180_000);

  afterAll(async () => {
    await lookup?.end();
    await world?.close();
    if (login === undefined) return;
    const cleanup = new Client(serverUrl ?? '');
    await cleanup.query(`drop role if exists "${login.name}"`).finally(() => cleanup.end());
  });

  roleCases();
  effectiveCases();
  readCases();
  refusalCases();
});

// ORCH37 (RELB-G2-POLICY): BYPASSRLS stays, so this is the pin: usage on its
// schema and select (id, key) on businesses, and no other grant anywhere.
function roleCases() {
  it('is a role no one logs in as, owning nothing, granted usage on public and select (id, key) on businesses alone', async () => {
    const [role] = await world.db.admin.execute<Record<string, boolean>>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = $1`,
      [LOOKUP],
    );
    expect(role).toStrictEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: true,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
    const held = await world.db.admin.execute<{ held: string }>(
      `select format('%s.%s %s', table_schema, table_name, privilege_type) as held
         from information_schema.table_privileges where grantee = $1
       union all
       select format('%s.%s(%s) %s', table_schema, table_name, column_name, privilege_type)
         from information_schema.column_privileges where grantee = $1
       union all
       select format('%s.%s() %s', routine_schema, routine_name, privilege_type)
         from information_schema.routine_privileges where grantee = $1
       union all
       select 'owns ' || relname from pg_class where relowner = (select oid from pg_roles where rolname = $1)
       union all
       select format('%s %s %s', c.relkind, c.oid::regclass, a.privilege_type)
         from pg_class c, aclexplode(c.relacl) a
        where c.relkind not in ('r', 'p', 'v', 'm', 'f') and a.grantee = (select oid from pg_roles where rolname = $1)
       union all
       select format('schema %s %s', n.nspname, a.privilege_type)
         from pg_namespace n, aclexplode(n.nspacl) a where a.grantee = (select oid from pg_roles where rolname = $1)
       union all
       select format('database %s %s', d.datname, a.privilege_type)
         from pg_database d, aclexplode(d.datacl) a where a.grantee = (select oid from pg_roles where rolname = $1)
       union all
       select 'member of ' || roleid::regrole from pg_auth_members
        where member = (select oid from pg_roles where rolname = $1)
       order by 1`,
      [LOOKUP],
    );
    expect(held.map((row) => row.held)).toStrictEqual([
      'public.businesses(id) SELECT',
      'public.businesses(key) SELECT',
      'schema public USAGE',
    ]);
  });
}

// REVB1SL01RELC: what the role can do, not only what was granted to it by
// name, so a grant to PUBLIC or through a membership counts. Invoker functions
// run with the caller's rights and widen nothing, so only definer ones count.
const EFFECTIVE = `
  select format('%I.%I %s', n.nspname, c.relname, p) as held
    from pg_class c join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema')
     and has_table_privilege($1, c.oid, p)
  union all
  select format('%I.%I(%I) %s', n.nspname, c.relname, a.attname, p)
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
   where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and n.nspname not in ('pg_catalog', 'information_schema') and has_column_privilege($1, c.oid, a.attnum, p)
  union all
  select format('%I.%I %s', n.nspname, c.relname, p)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest(array['USAGE', 'SELECT', 'UPDATE']) p
   where c.relkind = 'S' and has_sequence_privilege($1, c.oid, p)
  union all
  select format('%s EXECUTE', p.oid::regprocedure) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
     and has_function_privilege($1, p.oid, 'EXECUTE')
  union all
  select format('schema %s %s', n.nspname, p) from pg_namespace n, unnest(array['USAGE', 'CREATE']) p
   where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
     and has_schema_privilege($1, n.oid, p)
  order by 1`;

function effectiveCases() {
  it('can in effect read businesses (id, key) and use public, and nothing else, PUBLIC included', async () => {
    const held = await world.db.admin.execute<{ held: string }>(EFFECTIVE, [LOOKUP]);
    expect(held.map((row) => row.held)).toStrictEqual([
      'public.businesses(id) SELECT',
      'public.businesses(key) SELECT',
      'schema public USAGE',
    ]);
  });
}

function readCases() {
  it('reads every business id and key, and no other column of businesses', async () => {
    const { rows } = await lookup.query<{ id: string; key: string }>(
      'select id, key from public.businesses order by key',
    );
    expect(rows).toStrictEqual([
      { id: world.alpha, key: 'alpha' },
      { id: world.bravo, key: 'bravo' },
    ]);
    for (const text of [
      'select * from public.businesses',
      'select name from public.businesses',
      'select business_id from public.businesses',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt(lookup, text), text).toBe('42501');
    }
  });
}

function refusalCases() {
  it('is refused every other table, and every write, each 42501', async () => {
    expect(tables.length).toBeGreaterThan(30);
    const answers: string[] = [];
    for (const { qualified: table, column } of tables) {
      const statements = [
        `insert into ${table} default values`,
        `update ${table} set ${column} = ${column}`,
        `delete from ${table}`,
        ...(table === 'public.businesses' ? [] : [`select 1 from ${table} limit 1`]),
      ];
      for (const text of statements) {
        // oxlint-disable-next-line no-await-in-loop
        answers.push(`${text} ${await attempt(lookup, text)}`);
      }
    }
    expect(answers.filter((answer) => !answer.endsWith(' 42501'))).toStrictEqual([]);
  });

  it('refuses the three crossings, over rows that exist', async () => {
    const crossings: readonly [string, string, string][] = [
      ['another business', 'select * from public.records where business_id = $1', world.bravo],
      [
        'another record, same business',
        'select * from public.records where business_id = $1',
        world.alpha,
      ],
      ['another person', 'select * from public.people where business_id = $1', world.alpha],
    ];
    for (const [name, text, business] of crossings) {
      // oxlint-disable-next-line no-await-in-loop
      const present = await world.db.admin.execute(text, [business]);
      expect(present.length, name).toBeGreaterThan(0);
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt(lookup, text, [business]), name).toBe('42501');
    }
  });

  it('is what the served resolver reads a key through, and it answers that key alone', async () => {
    const connection = connectAsAdmin(login.url, { source: 'lookup' });
    try {
      const resolve = createBusinessResolver(connection);
      expect(await resolve('alpha')).toBe(world.alpha);
      expect(await resolve('bravo')).toBe(world.bravo);
      expect(await resolve('charlie')).toBeUndefined();
    } finally {
      await connection.close();
    }
  });
}
