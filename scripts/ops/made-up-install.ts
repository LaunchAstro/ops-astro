// SPDX-License-Identifier: AGPL-3.0-only
//
// The SQL the made-up guard installs (made-up-only.ts says what it is for):
// the ledger, the guard trigger, the watch and protect(), and the two
// catalogue questions both files ask, which tables are guarded and whether a
// guard still stands.

export const GUARD: string = 'ops_astro_made_up_guard';
export const LEDGER: string = 'ops_astro_made_up.untrusted';

/** Tenant tables and the sign-in table, from the catalogue: names, never rows. */
export const GUARDED: string = `select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and ((n.nspname = 'auth' and c.relname = 'users')
      or (n.nspname = 'public' and exists (select from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)))`;

/**
 * auth.users's oid, or null, found in the catalogue by schema and name as
 * GUARDED finds it, so no check names the table itself.
 */
const SIGN_IN_TABLE = `(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users')`;

/**
 * Whether guard trigger `t` stands: exactly the trigger protect() makes, an
 * immediate row trigger after insert or update calling guard(), with no
 * condition or column list, either enabled always with no argument, or, on
 * auth.users while this login does not own it, at origin with the argument
 * 'origin' (hex 6f726967696e00: the word and its closing NUL). Fields, not
 * printed text, so the session's search path cannot change the answer, and a
 * look-alike under the guard's name never stands. At origin a session in
 * replica mode skips the guard; only the table's owner could prevent that.
 */
export const STANDS: string = `(t.tgfoid = to_regprocedure('ops_astro_made_up.guard()')
    and t.tgtype = 21 and t.tgqual is null and t.tgattr = '' and t.tgconstraint = 0
    and ((t.tgenabled = 'A' and t.tgnargs = 0)
      or (t.tgenabled = 'O' and t.tgargs = decode('6f726967696e00', 'hex')
        and t.tgrelid = ${SIGN_IN_TABLE}
        and not pg_has_role(current_user, (select relowner from pg_class where oid = t.tgrelid),
          'USAGE'))))`;

/** Before the guard function: the schema, the ledger and note(). */
const LEDGER_AND_NOTE = [
  `create schema if not exists ops_astro_made_up`,
  `revoke all on schema ops_astro_made_up from public`,
  `create table if not exists ${LEDGER} (relation text primary key)`,
  `
  create or replace function ops_astro_made_up.note(relation text) returns void
    language sql security definer set search_path = pg_catalog, pg_temp
    as $$ insert into ${LEDGER} values (relation) on conflict do nothing $$`,
];

// A write is the seed's when it tags its transaction on the session the seed
// bound (`bindSeed`); it is a person's on staging when the role it runs as,
// an owner's definer function included, is neither owner nor superuser. The
// guard runs as the writer, so current_user is that role.
const guardFunction = (seedDigest: string): string =>
  `
    create or replace function ops_astro_made_up.guard() returns trigger
      language plpgsql security invoker set search_path = pg_catalog, pg_temp as $$
    begin
      if tg_table_schema = 'auth' then
        if new.email is null or lower(new.email) not like '%.local' then
          perform ops_astro_made_up.note('auth.users');
        end if;
      elsif encode(sha256(convert_to(coalesce(current_setting('ops_astro.writer', true), ''),
          'UTF8')), 'hex') || encode(sha256(convert_to(coalesce(
          current_setting('ops_astro.seeder', true), ''), 'UTF8')), 'hex')
          is distinct from '${seedDigest}${seedDigest}'
        and ((select rolsuper from pg_roles where rolname = current_user)
          or pg_has_role(current_user,
               (select datdba from pg_database where datname = current_database()), 'member'))
      then
        perform ops_astro_made_up.note(tg_table_schema || '.' || tg_table_name);
      end if;
      return null;
    end $$`;

/** After the guard function: the watch, protect() and the event trigger. */
const WATCH_AND_PROTECT = [
  `
  create or replace function ops_astro_made_up.watch() returns event_trigger
    language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
  declare
    command record;
  begin
    for command in select * from pg_event_trigger_ddl_commands() loop
      if command.command_tag = 'CREATE TABLE' then
        perform ops_astro_made_up.protect(command.objid);
      elsif command.command_tag = 'ALTER TABLE' and exists (select from pg_trigger t
          where t.tgrelid = command.objid and t.tgname = '${GUARD}' and not ${STANDS}) then
        perform ops_astro_made_up.note('guard');
      end if;
    end loop;
  end $$`,
  // Guards one table if it is a tenant or sign-in table without one. A table
  // is empty when CREATE TABLE ends; CREATE TABLE AS is another tag, never
  // guarded here, so its rows are never vouched for. Only a table's owner may
  // enable a trigger always. On hosted Supabase auth.users belongs to
  // supabase_auth_admin, so when this login does not own it the guard is made
  // with the argument 'origin' and left at origin (see STANDS); any other
  // table this login does not own still fails, as it always has.
  `
  create or replace function ops_astro_made_up.protect(target oid) returns void
    language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
  declare
    always boolean := target is distinct from ${SIGN_IN_TABLE}
      or pg_has_role((select relowner from pg_class where oid = target), 'USAGE');
  begin
    if target in (${GUARDED}) and not exists (select from pg_trigger
        where tgrelid = target and tgname = '${GUARD}') then
      execute format('create trigger ${GUARD} after insert or update on %s
        for each row execute function ops_astro_made_up.guard(%s)', target::regclass,
        case when always then '' else '''origin''' end);
      if always then
        execute format('alter table %s enable always trigger ${GUARD}', target::regclass);
      end if;
    end if;
  end $$`,
  `revoke all on all functions in schema ops_astro_made_up from public`,
  `drop event trigger if exists ${GUARD}`,
  `create event trigger ${GUARD} on ddl_command_end
  when tag in ('CREATE TABLE', 'ALTER TABLE') execute function ops_astro_made_up.watch()`,
  `alter event trigger ${GUARD} enable always`,
];

/**
 * The guard and the watch, in order; each statement is safe to run again.
 * `seedDigest` is the digest of the seed's tag, the only form the guard holds.
 */
export function installStatements(seedDigest: string): readonly string[] {
  return [...LEDGER_AND_NOTE, guardFunction(seedDigest), ...WATCH_AND_PROTECT];
}
