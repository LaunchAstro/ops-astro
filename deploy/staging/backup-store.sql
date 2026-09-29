-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Staging's backup store (ticket S0-3, lines C1 and C11). A database of its
-- own on staging's server, made once from the staging runbook:
--
--   create database ops_astro_staging_backups;
--   \c ops_astro_staging_backups
--   \i deploy/staging/backup-store.sql
--
-- after the migrations have made `ops_astro_backup` on the same server.
--
-- Three identities, held apart by the server rather than by the job.
-- `ops_astro_backup` inserts a dump's bytes and nothing else: no list, count,
-- read, change or delete, and not the time it was taken.
-- `ops_astro_backup_retention` sees ids and times, never bytes, and deletes
-- only past the window. `ops_astro_backup_restore` (the restore drill, S0-3c)
-- takes the newest backup through `backups.read_latest()` and nothing else;
-- what it gets is sealed, and only the operator's private key opens it. The
-- store writes a receipt for every add, read and delete: action, id, time,
-- size and login; no bytes, no fingerprint.
--
-- The retention window, how old the last passed restore drill may be, and
-- the most the store may hold are one row, `backups.settings`, here and
-- nowhere else.
--
-- The store is the one persistent place staging has (S0-1's disk row names its
-- volume as the only exception), so it bounds itself: an archive that would
-- take the stored total past `max_bytes` is refused (53400), whatever the job
-- does. The total is one row, `backups.stored`, that every insert updates only
-- while it stays within the cap: its row lock judges two archives written at
-- once one after the other, and a second that holds an older snapshot fails
-- rather than reading around the first. A delete gives its bytes back.

create schema backups;
revoke all on schema backups from public;

create table backups.settings (
  one boolean primary key default true check (one),
  retention_days integer not null check (retention_days between 1 and 365),
  restore_days integer not null check (restore_days between 1 and 365),
  max_bytes bigint not null check (max_bytes > 0)
);
insert into backups.settings (retention_days, restore_days, max_bytes)
values (35, 35, 4 * 1024 * 1024 * 1024::bigint);

create table backups.stored (
  one boolean primary key default true check (one),
  bytes bigint not null check (bytes >= 0)
);
insert into backups.stored (bytes) values (0);

create table backups.archives (
  id uuid primary key default gen_random_uuid(),
  taken_at timestamptz not null default now(),
  bytes bigint not null default 0,
  sha256 text not null default '',
  body bytea not null
);

create table backups.receipts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null check (action in ('backup recorded', 'backup read', 'backup expired')),
  archive_id uuid not null,
  taken_at timestamptz not null,
  bytes bigint not null,
  actor text not null default session_user
);

-- The time, size and fingerprint are the store's, never the writer's.
create function backups.archive_stamped() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  new.taken_at := now();
  new.bytes := length(new.body);
  new.sha256 := encode(sha256(new.body), 'hex');
  return new;
end $$;

create function backups.archive_receipt() returns trigger
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    insert into backups.receipts (action, archive_id, taken_at, bytes)
    values ('backup recorded', new.id, new.taken_at, new.bytes);
    return new;
  end if;
  insert into backups.receipts (action, archive_id, taken_at, bytes)
  values ('backup expired', old.id, old.taken_at, old.bytes);
  return old;
end $$;

-- Counts the archive's bytes in, or out, under the total's row lock.
create function backups.archive_bounded() returns trigger
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    update backups.stored set bytes = bytes - old.bytes;
    return old;
  end if;
  update backups.stored set bytes = bytes + length(new.body)
  where bytes + length(new.body) <= (select max_bytes from backups.settings);
  if not found then
    raise exception 'the backup store is full: this archive would take it past backups.settings.max_bytes'
      using errcode = 'configuration_limit_exceeded';
  end if;
  return new;
end $$;

create function backups.receipts_append_only() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'backups.receipts is append-only' using errcode = 'insufficient_privilege';
end $$;

revoke execute on function backups.archive_stamped() from public;
revoke execute on function backups.archive_receipt() from public;
revoke execute on function backups.archive_bounded() from public;
revoke execute on function backups.receipts_append_only() from public;

create trigger archive_stamped before insert on backups.archives
  for each row execute function backups.archive_stamped();
create trigger archive_receipt after insert or delete on backups.archives
  for each row execute function backups.archive_receipt();
create trigger archive_bounded before insert on backups.archives
  for each row execute function backups.archive_bounded();
create trigger archive_unbounded after delete on backups.archives
  for each row execute function backups.archive_bounded();
create trigger receipts_append_only before update or delete or truncate on backups.receipts
  for each statement execute function backups.receipts_append_only();

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_backup_retention') then
    create role ops_astro_backup_retention nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_backup_restore') then
    create role ops_astro_backup_restore nologin;
  end if;
end $$;
alter role ops_astro_backup_retention nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role ops_astro_backup_restore nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- A read has no trigger, so the one way to read a backup is a function that
-- writes its receipt first, on a connection of its own (dblink) that commits
-- before the bytes are returned: a reader that rolls back keeps its receipt.
-- dblink connects without a password only for a superuser, so the store is
-- made by staging's admin, and its functions stay out of every other role's
-- reach in a schema of their own.
create schema backups_audit;
revoke all on schema backups_audit from public;
create extension dblink schema backups_audit;

create function backups.read_latest()
  returns table (id uuid, taken_at timestamptz, body bytea)
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  picked backups.archives;
begin
  select a.* into picked from backups.archives a order by a.taken_at desc, a.id desc limit 1;
  if not found then
    return;
  end if;
  perform backups_audit.dblink_exec(
    format('dbname=''%s'' user=''%s''', current_database(), current_user),
    format(
      'insert into backups.receipts (action, archive_id, taken_at, bytes, actor) values (%L, %L, %L, %s, %L)',
      'backup read', picked.id, picked.taken_at, picked.bytes, session_user
    )
  );
  return query select picked.id, picked.taken_at, picked.body;
end $$;
revoke execute on function backups.read_latest() from public;

grant usage on schema backups to ops_astro_backup, ops_astro_backup_retention;
grant insert (body) on backups.archives to ops_astro_backup;
grant select (id, taken_at), delete on backups.archives to ops_astro_backup_retention;
grant select on backups.settings to ops_astro_backup_retention;
grant usage on schema backups to ops_astro_backup_restore;
grant execute on function backups.read_latest() to ops_astro_backup_restore;

-- The restore drill's receipts (ticket S0-3, lines C4 to C6 and C10). The
-- drill writes one row per run through `backups.record_drill`, as the restore
-- identity, and the row carries times, majors, counts and stage names only: no
-- record data, key, credential, fingerprint or path. The operations view reads
-- the date of the last passed drill from here (C55). `backups.restore_fresh()`
-- answers only yes or no: whether a drill passed inside the window
-- `backups.settings.restore_days` sets. The daily upkeep job asks it and pings
-- the watcher's restore heartbeat only on yes, so a stale restore raises S0-2's
-- alert.
create table backups.drills (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  outcome text not null check (outcome in ('passed', 'failed')),
  stage text check (stage in ('scope', 'fetch', 'open', 'start', 'target', 'restore', 'check')),
  operator uuid not null,
  archive_taken_at timestamptz,
  production_major integer not null,
  source_major integer,
  target_major integer,
  tables integer,
  timings jsonb not null,
  actor text not null default session_user,
  check ((outcome = 'passed') = (stage is null)),
  check (outcome = 'failed' or (archive_taken_at is not null and source_major is not null
    and target_major = production_major and tables > 0)),
  -- Stage timings in milliseconds, keyed by the drill's timed stages, and nothing else.
  check (jsonb_typeof(timings) = 'object' and not jsonb_path_exists(timings,
    '$.keyvalue() ? (!(@.key like_regex "^(fetch|open|start|restore|check)$") || @.value.type() != "number")'))
);
create trigger drills_append_only before update or delete or truncate on backups.drills
  for each statement execute function backups.receipts_append_only();

-- It answers the date of the last passed drill, this one included.
create function backups.record_drill(
  text, text, uuid, timestamptz, integer, integer, integer, integer, jsonb
) returns timestamptz
  language sql security definer set search_path = pg_catalog as $$
  insert into backups.drills (outcome, stage, operator, archive_taken_at, production_major,
    source_major, target_major, tables, timings, actor)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, session_user);
  select max(at) from backups.drills where outcome = 'passed';
$$;
revoke execute on function backups.record_drill(text, text, uuid, timestamptz, integer, integer,
  integer, integer, jsonb) from public;
grant execute on function backups.record_drill(text, text, uuid, timestamptz, integer, integer,
  integer, integer, jsonb) to ops_astro_backup_restore;

create function backups.restore_fresh() returns boolean
  language sql stable security definer set search_path = pg_catalog as $$
  select exists (
    select from backups.drills
    where outcome = 'passed'
      and at > now() - make_interval(days => (select restore_days from backups.settings))
  )
$$;
revoke execute on function backups.restore_fresh() from public;
grant execute on function backups.restore_fresh() to ops_astro_backup_retention;

-- Row security holds the window for the retention identity, and it is forced,
-- so the backup identity's own bypass of row security on the source reads
-- nothing more here: it holds no select to bypass with.
alter table backups.archives enable row level security;
alter table backups.archives force row level security;
create policy backup_adds on backups.archives for insert to ops_astro_backup with check (true);
create policy retention_sees on backups.archives for select to ops_astro_backup_retention using (true);
create policy retention_deletes_expired on backups.archives for delete to ops_astro_backup_retention
  using (taken_at < now() - make_interval(days => (select retention_days from backups.settings)));
