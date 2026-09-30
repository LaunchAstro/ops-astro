// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging holds made-up data only (ticket S0-1), so the seed refuses a database
// it cannot vouch for. It decides from metadata the seed itself installed, and
// never reads a business's, person's, record's or sign-in's row to decide:
//
// - The mark: a comment on the database, written by the seed.
// - The guard: a trigger on every tenant table (each public table with a
//   `business_id`) and on `auth.users`. A write by the database's owner or a
//   superuser that the seed did not tag, as a restore or a hand-loaded file
//   is, lands in the guard's ledger by table name, never by content. So does a
//   sign-in whose address is not a made-up `.local` one. Writes through the
//   application's own role are what people typed on staging, and pass. The
//   seed's tag is a secret its process makes at start and never stores: the
//   guard holds only its digest and admits the tag only on the session the
//   seed bound by parameter, so no other session, restore or file can make or
//   replay a tag that passes, and the next seed run replaces it.
// - The watch: an event trigger that guards a table from its creation and
//   notes a guard switched off (`pg_restore --disable-triggers` does that).
//   Guards and watch fire in every replication mode.
//
// A marked database is refused if its ledger names anything, or any tenant
// table lacks an enabled guard. An unmarked one is refused unless a person
// confirms it (LOCAL_SEED_MADE_UP=confirm) and every tenant table has never
// held a row, judged by its storage size. The guard stops a mistake; the owner
// can remove it on purpose, as the owner can write the mark by hand.
import { createHash, randomBytes } from 'node:crypto';

/** The one call this needs from the owner connection. */
export interface OwnerQuery {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

const MARK = 'ops-astro made-up data; businesses: ';
const PEOPLE = '; people: ';
const GUARD = 'ops_astro_made_up_guard';
const LEDGER = 'ops_astro_made_up.untrusted';
const digest = (id: string): string => createHash('sha256').update(id).digest('hex');
/** This process's seed tag; the guard knows its digest and nothing else. */
const SEED_SECRET = randomBytes(32).toString('hex');
const joined = (list: readonly string[]): string =>
  list
    .map((id) => digest(id))
    .toSorted()
    .join(',');

/** Tenant tables and the sign-in table, from the catalogue: names, never rows. */
const GUARDED = `select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and ((n.nspname = 'auth' and c.relname = 'users')
      or (n.nspname = 'public' and exists (select from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)))`;

const SIGNS: Readonly<Record<string, string>> = {
  'public.businesses': 'it holds a business the seed did not make',
  'public.people': 'it holds a person the seed did not make',
  'auth.users': 'it holds a sign-in that is not a made-up address',
  guard: 'a made-up guard was switched off',
};
const RECORD = 'it holds a record the seed cannot vouch for';
const UNGUARDED = 'a table has no made-up guard';

async function yes(admin: OwnerQuery, text: string): Promise<boolean> {
  const [row] = await admin.execute<{ yes: boolean }>(`select (${text}) as yes`);
  return row?.yes === true;
}

async function marked(admin: OwnerQuery): Promise<boolean> {
  const [row] = await admin.execute<{ mark: string | null }>(
    `select shobj_description(oid, 'pg_database') as mark
       from pg_database where datname = current_database()`,
  );
  const mark = row?.mark;
  return typeof mark === 'string' && mark.startsWith(MARK) && mark.includes(PEOPLE);
}

/**
 * Why this database may not be seeded, or none. `confirmed` is a person's
 * LOCAL_SEED_MADE_UP=confirm; it opens only an unmarked database that has never
 * held a tenant row. The seed's keys and names are no longer matched against
 * rows, so the second and fourth arguments are accepted and not read.
 */
export async function productionSigns(
  admin: OwnerQuery,
  _seedKeys: readonly string[] = [],
  confirmed = false,
  _seedNames: readonly string[] = [],
): Promise<string[]> {
  if (await marked(admin)) return guardSigns(admin);
  if (!confirmed) return ['it carries no made-up mark'];
  const empty = `coalesce((select bool_and(pg_relation_size(g.oid) = 0) from (${GUARDED}) g), true)`;
  return (await yes(admin, empty)) ? [] : ['it carries no made-up mark and is not a new database'];
}

/** A marked database: what its guard's ledger names, and any table left unguarded. */
async function guardSigns(admin: OwnerQuery): Promise<string[]> {
  const signs = new Set<string>();
  if (await yes(admin, `to_regclass('${LEDGER}') is not null`))
    for (const { relation } of await admin.execute<{ relation?: string }>(
      `select relation from ${LEDGER} order by relation`,
    ))
      signs.add(SIGNS[relation ?? ''] ?? RECORD);
  else signs.add(UNGUARDED);
  const covered = `not exists (select from (${GUARDED}) g where not exists (select from pg_trigger t
      where t.tgrelid = g.oid and t.tgname = '${GUARD}' and t.tgenabled = 'A'))
    and exists (select from pg_event_trigger where evtname = '${GUARD}' and evtenabled = 'A')`;
  if (!(await yes(admin, covered))) signs.add(UNGUARDED);
  return [...signs];
}

/** The guard and the watch, in order; each statement is safe to run again. */
const INSTALL = [
  `create schema if not exists ops_astro_made_up`,
  `revoke all on schema ops_astro_made_up from public`,
  `create table if not exists ${LEDGER} (relation text primary key)`,
  `
    create or replace function ops_astro_made_up.note(relation text) returns void
      language sql security definer set search_path = pg_catalog, pg_temp
      as $$ insert into ${LEDGER} values (relation) on conflict do nothing $$`,
  // A write is the seed's when it tags its transaction on the session the seed
  // bound (`bindSeed`); it is a person's on staging when the role it runs as,
  // an owner's definer function included, is neither owner nor superuser. The
  // guard runs as the writer, so current_user is that role.
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
          is distinct from '${digest(SEED_SECRET)}${digest(SEED_SECRET)}'
        and ((select rolsuper from pg_roles where rolname = current_user)
          or pg_has_role(current_user,
               (select datdba from pg_database where datname = current_database()), 'member'))
      then
        perform ops_astro_made_up.note(tg_table_schema || '.' || tg_table_name);
      end if;
      return null;
    end $$`,
  `
    create or replace function ops_astro_made_up.watch() returns event_trigger
      language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
    declare
      command record;
    begin
      for command in select * from pg_event_trigger_ddl_commands() loop
        if command.command_tag = 'CREATE TABLE' then
          perform ops_astro_made_up.protect(command.objid);
        elsif command.command_tag = 'ALTER TABLE' and exists (select from pg_trigger
            where tgrelid = command.objid and tgname = '${GUARD}' and tgenabled <> 'A') then
          perform ops_astro_made_up.note('guard');
        end if;
      end loop;
    end $$`,
  // Guards one table if it is a tenant or sign-in table without one. A table
  // is empty when CREATE TABLE ends; CREATE TABLE AS is another tag, never
  // guarded here, so its rows are never vouched for.
  `
    create or replace function ops_astro_made_up.protect(target oid) returns void
      language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
    begin
      if target in (${GUARDED}) and not exists (select from pg_trigger
          where tgrelid = target and tgname = '${GUARD}') then
        execute format('create trigger ${GUARD} after insert or update on %s
          for each row execute function ops_astro_made_up.guard()', target::regclass);
        execute format('alter table %s enable always trigger ${GUARD}', target::regclass);
      end if;
    end $$`,
  `revoke all on all functions in schema ops_astro_made_up from public`,
  `drop event trigger if exists ${GUARD}`,
  `create event trigger ${GUARD} on ddl_command_end
    when tag in ('CREATE TABLE', 'ALTER TABLE') execute function ops_astro_made_up.watch()`,
  `alter event trigger ${GUARD} enable always`,
];

/** Install, or refresh, the guard and the watch. It never clears the ledger. */
export async function guardMadeUp(admin: OwnerQuery): Promise<void> {
  // In order: each statement builds on the one before.
  // oxlint-disable-next-line no-await-in-loop
  for (const statement of INSTALL) await admin.execute(statement);
  for (const { oid } of await admin.execute<{ oid: number }>(GUARDED))
    // One table's guard at a time: each is DDL on its own table.
    // oxlint-disable-next-line no-await-in-loop
    await admin.execute('select ops_astro_made_up.protect($1)', [oid]);
}

/** Guard the database, then mark it with the businesses and people the seed made. */
export async function markMadeUp(
  admin: OwnerQuery,
  businessIds: readonly string[],
  personIds: readonly string[] = [],
): Promise<void> {
  await guardMadeUp(admin);
  const [row] = await admin.execute<{ statement: string }>(
    "select format('comment on database %I is %L', current_database(), $1::text) as statement",
    [`${MARK}${joined(businessIds)}${PEOPLE}${joined(personIds)}`],
  );
  if (row === undefined) throw new Error('made-up-only: no mark statement');
  await admin.execute(row.statement);
}

/**
 * The seed's admission: judge, guard, then judge again before the first write.
 * A row that lands between the first judgement and the guard is seen by the
 * second, since the seed has written nothing yet; one after it is noted.
 */
export async function admitMadeUp(admin: OwnerQuery, confirmed: boolean): Promise<string[]> {
  const signs = await productionSigns(admin, [], confirmed);
  if (signs.length > 0) return signs;
  await guardMadeUp(admin);
  return productionSigns(admin, [], confirmed);
}

/**
 * A FROM item that tags the statement's transaction as the seed's, so the guard
 * lets the seed's own write through the owner connection pass.
 */
export const SEED_TAG: string = `(select set_config('ops_astro.writer', '${SEED_SECRET}', true)) as seed`;

/**
 * Bind the seed's own session (one backend, `max: 1`): the tag passes only
 * there. The secret goes as a parameter, which no other session can read in
 * pg_stat_activity, so a tag read from a statement's text replays nowhere.
 */
export async function bindSeed(admin: OwnerQuery): Promise<void> {
  await admin.execute(`select set_config('ops_astro.seeder', $1, false)`, [SEED_SECRET]);
}
