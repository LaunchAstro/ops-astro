// SPDX-License-Identifier: AGPL-3.0-only
//
// Two reads that say what a database is, for comparing two databases built
// different ways (migrated-template.test.ts: a clone of the migrated template
// against a database migrated from empty). Each returns sorted lines, so two
// equal databases give two equal lists and a difference names the object.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

const NOT_SYSTEM = `not in (select oid from pg_namespace where nspname ~ '^(pg_|information_schema)')`;

/**
 * Everything inside the database, one line per object, read the way a schema
 * dump prints it: schemas, relations with their owners, privileges and row
 * security, columns, constraints, indexes, functions with their bodies,
 * triggers and whether each fires, policies, views, types, default
 * privileges, extensions, event triggers, the migration ledger and each
 * table's row count.
 */
const CATALOGUE = `
select format('schema %s owner=%s acl=%s', nspname, pg_get_userbyid(nspowner), nspacl) line
  from pg_namespace where oid ${NOT_SYSTEM}
union all
select format('relation %s %s owner=%s acl=%s rls=%s/%s options=%s', c.oid::regclass, c.relkind,
              pg_get_userbyid(c.relowner), c.relacl, c.relrowsecurity, c.relforcerowsecurity, c.reloptions)
  from pg_class c where c.relnamespace ${NOT_SYSTEM}
union all
select format('column %s.%s %s not-null=%s default=%s acl=%s', a.attrelid::regclass, a.attname,
              format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attacl)
  from pg_attribute a join pg_class c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where c.relnamespace ${NOT_SYSTEM} and a.attnum > 0 and not a.attisdropped
union all
select format('constraint %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid))
  from pg_constraint where connamespace ${NOT_SYSTEM}
union all
select 'index ' || pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class c on c.oid = i.indexrelid where c.relnamespace ${NOT_SYSTEM}
union all
select format('function %s owner=%s acl=%s config=%s %s', p.oid::regprocedure, pg_get_userbyid(p.proowner),
              p.proacl, p.proconfig, case when p.prokind = 'a' then 'aggregate' else pg_get_functiondef(p.oid) end)
  from pg_proc p where p.pronamespace ${NOT_SYSTEM}
union all
select format('trigger %s %s enabled=%s', tgrelid::regclass, pg_get_triggerdef(oid), tgenabled)
  from pg_trigger where not tgisinternal
union all
select format('policy %s.%s %s %s %s %s %s %s', schemaname, tablename, policyname, permissive, roles, cmd,
              qual, with_check)
  from pg_policies
union all
select format('view %s %s', c.oid::regclass, pg_get_viewdef(c.oid))
  from pg_class c where c.relkind in ('v', 'm') and c.relnamespace ${NOT_SYSTEM}
union all
select format('type %s %s %s', t.oid::regtype, t.typtype,
              (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum where enumtypid = t.oid))
  from pg_type t where t.typnamespace ${NOT_SYSTEM} and t.typtype in ('e', 'd', 'c', 'r', 'm')
union all
select format('default privileges %s %s %s %s', pg_get_userbyid(defaclrole), defaclnamespace::regnamespace,
              defaclobjtype, defaclacl)
  from pg_default_acl
union all
select format('extension %s %s', extname, extversion) from pg_extension
union all
select format('event trigger %s %s %s', evtname, evtevent, evtfoid::regproc) from pg_event_trigger
union all
select format('ledger %s %s', version, checksum) from ops.schema_migrations
union all
select format('rows %s %s', c.oid::regclass,
              (xpath('/row/n/text()', query_to_xml(format('select count(*) n from %s', c.oid::regclass),
                                                   false, true, '')))[1]::text)
  from pg_class c where c.relkind in ('r', 'p') and c.relnamespace ${NOT_SYSTEM}
order by 1`;

/**
 * The database as the server holds it: its privileges, settings, owner,
 * encoding, comment and whether it takes connections, and the harness's two
 * login roles for it with their memberships. Role names carry the database's
 * own name, so they come back as `<login>` and `<restricted>`.
 */
const DATABASE_FACTS = `
with db as (select * from pg_database where datname = $1),
     mine as (select oid from pg_roles where rolname in ($1 || '_app', $1 || '_out'))
select format('privilege %s %s', case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end,
              a.privilege_type) fact
  from db, aclexplode(coalesce(db.datacl, acldefault('d', db.datdba))) a
union all
select format('database owner=%s encoding=%s collate=%s ctype=%s connections=%s template=%s limit=%s comment=%s',
              pg_get_userbyid(datdba), pg_encoding_to_char(encoding), datcollate, datctype, datallowconn,
              datistemplate, datconnlimit, shobj_description(oid, 'pg_database'))
  from db
union all
select format('setting %s %s', coalesce(pg_get_userbyid(nullif(setrole, 0)), 'all'), setconfig)
  from pg_db_role_setting, db where setdatabase = db.oid
union all
select format('role %s login=%s super=%s createdb=%s createrole=%s bypassrls=%s inherit=%s', rolname,
              rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit)
  from pg_roles where oid in (select oid from mine)
union all
select format('member %s of %s', pg_get_userbyid(m.member), m.roleid::regrole)
  from pg_auth_members m where m.member in (select oid from mine)
order by 1`;

/** Every object in the database `admin` is connected to, one sorted line each. */
export async function catalogueOf(admin: AdminConnection): Promise<string[]> {
  return (await admin.execute<{ line: string }>(CATALOGUE)).map((row) => row.line);
}

/** The server's facts about database `name`, read through `server`, role names as placeholders. */
export async function databaseFactsOf(server: AdminConnection, name: string): Promise<string[]> {
  const rows = await server.execute<{ fact: string }>(DATABASE_FACTS, [name]);
  return rows.map((row) =>
    row.fact
      .replaceAll(`${name}_app`, '<login>')
      .replaceAll(`${name}_out`, '<restricted>')
      .replaceAll(name, '<database>'),
  );
}
