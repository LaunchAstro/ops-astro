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
-- Two identities, held apart by the server rather than by the job.
-- `ops_astro_backup` inserts a dump's bytes and nothing else: no list, count,
-- read, change or delete, and not the time it was taken.
-- `ops_astro_backup_retention` sees ids and times, never bytes, and deletes
-- only past the window. The store writes a receipt for every add and delete:
-- action, id, time, size and login; no bytes, no fingerprint.
--
-- The retention window is one row, `backups.settings`, here and nowhere else.

create schema backups;
revoke all on schema backups from public;

create table backups.settings (
  one boolean primary key default true check (one),
  retention_days integer not null check (retention_days between 1 and 365)
);
insert into backups.settings (retention_days) values (35);

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
  action text not null check (action in ('backup recorded', 'backup expired')),
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

create function backups.receipts_append_only() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'backups.receipts is append-only' using errcode = 'insufficient_privilege';
end $$;

revoke execute on function backups.archive_stamped() from public;
revoke execute on function backups.archive_receipt() from public;
revoke execute on function backups.receipts_append_only() from public;

create trigger archive_stamped before insert on backups.archives
  for each row execute function backups.archive_stamped();
create trigger archive_receipt after insert or delete on backups.archives
  for each row execute function backups.archive_receipt();
create trigger receipts_append_only before update or delete or truncate on backups.receipts
  for each statement execute function backups.receipts_append_only();

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_backup_retention') then
    create role ops_astro_backup_retention nologin;
  end if;
end $$;
alter role ops_astro_backup_retention nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

grant usage on schema backups to ops_astro_backup, ops_astro_backup_retention;
grant insert (body) on backups.archives to ops_astro_backup;
grant select (id, taken_at), delete on backups.archives to ops_astro_backup_retention;
grant select on backups.settings to ops_astro_backup_retention;

-- Row security holds the window for the retention identity, and it is forced,
-- so the backup identity's own bypass of row security on the source reads
-- nothing more here: it holds no select to bypass with.
alter table backups.archives enable row level security;
alter table backups.archives force row level security;
create policy backup_adds on backups.archives for insert to ops_astro_backup with check (true);
create policy retention_sees on backups.archives for select to ops_astro_backup_retention using (true);
create policy retention_deletes_expired on backups.archives for delete to ops_astro_backup_retention
  using (taken_at < now() - make_interval(days => (select retention_days from backups.settings)));
