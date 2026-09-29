-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Staging's backup store (ticket S0-3, lines C1 and C11). The database
-- `ops_astro_staging_backups` on its own server, `backups` in
-- deploy/staging/compose.json, which publishes no port; made once from the
-- restore runbook, as the store's admin:
--
--   \i deploy/staging/backup-store.sql
--
-- The store is a server apart from staging's database, so it makes
-- `ops_astro_backup` itself when the server has none (no login, no bypass of
-- row security: here it only adds). Where one server holds both, as the test
-- clusters do, the role migration 0034 made is left as it is.
--
-- Three identities, held apart by the server rather than by the job.
-- `ops_astro_backup` adds a dump's sealed bytes through `backups.add_part` and
-- `backups.complete_archive` and nothing else: no list, count, read, change or
-- delete, and not the time it was taken. `ops_astro_backup_retention` sees ids
-- and times, never bytes, and deletes only past the window.
-- `ops_astro_backup_restore` (the restore drill, S0-3c) takes the newest backup
-- through `backups.read_latest(person, business)` and `backups.read_part()`
-- and nothing else, and only as a login the installation appointed as that
-- person, in the operating business (below),
-- with the digest the store recorded when it took it; what it gets is sealed,
-- and only the operator's private key opens it. The store writes a receipt for
-- every add, read (the header, and each part it hands out) and delete: action,
-- id, time, size and login; no bytes, no fingerprint.
--
-- The retention window, how old the last passed restore drill may be, and
-- the most the store may hold are one row, `backups.settings`, here and
-- nowhere else.
--
-- An archive can be as large as the cap, past what one value or the store's
-- memory holds (REV158S criterion 5), so it is kept in parts of at most 4 MiB,
-- `backups.archive_parts`, under one header row, `backups.archives`. The job
-- adds them in order in one transaction and completes the archive with its
-- size and the sha256 of its whole ciphertext, which it computes as the parts
-- go out: SQL cannot hash across statements, so the store checks the size
-- itself and hashes each part itself. An archive not completed in the
-- transaction that opened it cannot commit, so no part of an unfinished upload
-- is ever kept or seen.
--
-- The store is the one persistent place staging has (S0-1's disk row names its
-- volume as the only exception), so it bounds itself: a part that would take
-- the stored total past `max_bytes` is refused (53400), whatever the job does,
-- and the whole upload with it. The cap bounds archive bodies; receipts and
-- drill rows are small and append-only. The total is one row,
-- `backups.stored`, that every part updates only while it stays within the
-- cap: its row lock judges two archives written at once one after the other,
-- and a second that holds an older snapshot fails rather than reading around
-- the first. A delete gives its archive's bytes back.

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

-- The time, the size and each part's digest are the store's; the whole
-- digest is the job's, checked by every drill that reads the archive back.
create table backups.archives (
  id uuid primary key default gen_random_uuid(),
  taken_at timestamptz not null default now(),
  bytes bigint not null default 0 check (bytes >= 0),
  parts integer not null default 0 check (parts >= 0),
  sha256 text not null default '',
  complete boolean not null default false,
  check (not complete or (parts > 0 and sha256 ~ '^[0-9a-f]{64}$'))
);

create table backups.archive_parts (
  archive_id uuid not null references backups.archives on delete cascade,
  seq integer not null check (seq >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  chunk bytea not null check (length(chunk) between 1 and 4194304),
  primary key (archive_id, seq)
);
-- Sealed bytes do not compress; the server need not try.
alter table backups.archive_parts alter column chunk set storage external;

create table backups.receipts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null check (action in ('backup recorded', 'backup read', 'backup expired')),
  archive_id uuid not null,
  taken_at timestamptz not null,
  bytes bigint not null,
  actor text not null default session_user,
  -- A read of one part (`read_part`): its number, and `bytes` is its size.
  part integer check (part >= 0)
);

-- Adds part `seq` of the archive this transaction is writing; part 0 opens
-- it. Parts come in order from 0, none twice, each counted into the stored
-- total under its row lock.
create function backups.add_part(seq integer, chunk bytea) returns void
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  writing backups.archives;
begin
  if $2 is null or length($2) not between 1 and 4194304 then
    raise exception 'a part is 1 byte to 4 MiB' using errcode = 'invalid_parameter_value';
  end if;
  -- Every committed archive is complete, and another transaction's open one
  -- is not visible here, so an open archive is this transaction's own.
  select a.* into writing from backups.archives a where not a.complete for update;
  if $1 = 0 then
    if found then
      raise exception 'an archive is open already' using errcode = 'object_not_in_prerequisite_state';
    end if;
    insert into backups.archives default values returning * into writing;
  elsif not found or $1 is distinct from writing.parts then
    raise exception 'parts are added in order from 0, none twice' using errcode = 'invalid_parameter_value';
  end if;
  update backups.stored set bytes = bytes + length($2)
  where bytes + length($2) <= (select max_bytes from backups.settings);
  if not found then
    raise exception 'the backup store is full: this archive would take it past backups.settings.max_bytes'
      using errcode = 'configuration_limit_exceeded';
  end if;
  insert into backups.archive_parts (archive_id, seq, sha256, chunk)
  values (writing.id, $1, encode(sha256($2), 'hex'), $2);
  update backups.archives a set parts = a.parts + 1, bytes = a.bytes + length($2)
  where a.id = writing.id;
end $$;

-- Completes this transaction's archive: the size the job sent must be the one
-- the store counted, and the digest is the whole ciphertext's. The job sends
-- both as bound parameters, so no statement the server logs carries the
-- digest.
create function backups.complete_archive(bytes bigint, sha256 text)
  returns void
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  writing backups.archives;
begin
  select a.* into writing from backups.archives a where not a.complete for update;
  if not found then
    raise exception 'no archive is open' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if $1 is distinct from writing.bytes or $2 is null or $2 !~ '^[0-9a-f]{64}$' then
    raise exception 'the archive is not the one its parts make' using errcode = 'invalid_parameter_value';
  end if;
  update backups.archives a set complete = true, sha256 = $2
  where a.id = writing.id;
  insert into backups.receipts (action, archive_id, taken_at, bytes)
  values ('backup recorded', writing.id, writing.taken_at, writing.bytes);
end $$;

-- At commit: an archive opened in this transaction was completed in it.
create function backups.archive_completed() returns trigger
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if exists (select from backups.archives a where a.id = new.id and not a.complete) then
    raise exception 'an archive is completed in the transaction that opened it'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return null;
end $$;

-- A deleted archive gives its bytes back and leaves a receipt.
create function backups.archive_expired() returns trigger
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  update backups.stored set bytes = bytes - old.bytes;
  insert into backups.receipts (action, archive_id, taken_at, bytes)
  values ('backup expired', old.id, old.taken_at, old.bytes);
  return old;
end $$;

create function backups.receipts_append_only() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'backups.receipts is append-only' using errcode = 'insufficient_privilege';
end $$;

revoke execute on function backups.add_part(integer, bytea) from public;
revoke execute on function backups.complete_archive(bigint, text) from public;
revoke execute on function backups.archive_completed() from public;
revoke execute on function backups.archive_expired() from public;
revoke execute on function backups.receipts_append_only() from public;

create constraint trigger archive_completed after insert on backups.archives
  deferrable initially deferred for each row execute function backups.archive_completed();
create trigger archive_expired after delete on backups.archives
  for each row execute function backups.archive_expired();
create trigger receipts_append_only before update or delete or truncate on backups.receipts
  for each statement execute function backups.receipts_append_only();

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_backup') then
    create role ops_astro_backup nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
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
-- before anything is returned: a reader that rolls back keeps its receipt.
-- dblink connects without a password only for a superuser, so the store is
-- made by staging's admin, and its functions stay out of every other role's
-- reach in a schema of their own.
create schema backups_audit;
revoke all on schema backups_audit from public;
create extension dblink schema backups_audit;

-- The newest complete archive's header, its read logged; only for the login
-- the installation appointed as `person`, in the operating business
-- `business` (backups.appointed_operator, below), checked here before any
-- byte or read is handed out, so an export or a drill is the appointed
-- operator's own act whatever the command that asks believed.
create function backups.read_latest(person uuid, business text)
  returns table (id uuid, taken_at timestamptz, bytes bigint, parts integer, sha256 text)
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  picked backups.archives;
begin
  if not backups.appointed_operator($1, $2) then
    raise exception 'not the installation''s appointed operator' using errcode = '42501';
  end if;
  select a.* into picked from backups.archives a
  where a.complete order by a.taken_at desc, a.id desc limit 1;
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
  return query select picked.id, picked.taken_at, picked.bytes, picked.parts, picked.sha256;
end $$;
revoke execute on function backups.read_latest(uuid, text) from public;

-- One part of a complete archive, with the digest the store took of it; only
-- of an archive whose read the store logged for this same login inside the
-- freshness window. Every part it hands out leaves a receipt of its own, as
-- the header read does, committed before the part is returned.
create function backups.read_part(archive uuid, seq integer)
  returns table (part_sha256 text, part bytea)
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  found_part backups.archive_parts;
  owner backups.archives;
begin
  if not exists (
    select from backups.receipts r
    where r.action = 'backup read' and r.archive_id = $1 and r.part is null and r.actor = session_user
      and r.at > now() - make_interval(days => (select restore_days from backups.settings))
  ) then
    raise exception 'no read of that archive by this login inside the window' using errcode = '42501';
  end if;
  select a.* into owner from backups.archives a where a.id = $1 and a.complete;
  select p.* into found_part from backups.archive_parts p where p.archive_id = $1 and p.seq = $2;
  if owner.id is null or found_part.archive_id is null then
    return;
  end if;
  perform backups_audit.dblink_exec(
    format('dbname=''%s'' user=''%s''', current_database(), current_user),
    format(
      'insert into backups.receipts (action, archive_id, taken_at, bytes, actor, part) values (%L, %L, %L, %s, %L, %s)',
      'backup read', owner.id, owner.taken_at, length(found_part.chunk), session_user, found_part.seq
    )
  );
  return query select found_part.sha256, found_part.chunk;
end $$;
revoke execute on function backups.read_part(uuid, integer) from public;

grant usage on schema backups to ops_astro_backup, ops_astro_backup_retention;
grant execute on function backups.add_part(integer, bytea) to ops_astro_backup;
grant execute on function backups.complete_archive(bigint, text) to ops_astro_backup;
grant select (id, taken_at), delete on backups.archives to ops_astro_backup_retention;
grant select on backups.settings to ops_astro_backup_retention;
grant usage on schema backups to ops_astro_backup_restore;
grant execute on function backups.read_latest(uuid, text) to ops_astro_backup_restore;
grant execute on function backups.read_part(uuid, integer) to ops_astro_backup_restore;

-- The installation (S0-3e): the operating business, and the store login of
-- each operator it appointed with the person that operator is. The store's
-- admin writes both at installation, from the restore runbook; no identity is
-- granted anything on either, and the operating business is never changed
-- or removed once written.
--
-- The trust model (ticket S0-3, lines 13, 39, 53 and 66): a passed restore
-- drill is the appointed operator's own attestation that they ran the real
-- restore on a clean throwaway host. No value in a dump proves that, since
-- the key holder can read every value in it without restoring anything. So
-- the store takes a pass only as that operator's own act: through their own
-- store login, for the person the installation appointed that login as, in
-- the operating business, for an archive this same login read and whose
-- whole digest the operator's command computed again from the bytes it
-- restored (a bound parameter, never printed). The restore command admits
-- the same person only after verifying their sign-in in the operating
-- business (scripts/ops/operator.ts). The store keeps who recorded which
-- archive, as whom and when. A login the installation did not appoint, the
-- restore identity alone, reads no archive, and records a failed drill and
-- never a pass.
create table backups.installation (
  one boolean primary key default true check (one),
  operating_business text not null check (operating_business <> '')
);
create function backups.installation_fixed() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'the installation is written once' using errcode = 'insufficient_privilege';
end $$;
revoke execute on function backups.installation_fixed() from public;
create trigger installation_fixed before update or delete or truncate on backups.installation
  for each statement execute function backups.installation_fixed();

create table backups.appointed (
  login name primary key,
  person uuid not null
);

-- Whether this login is the one the installation appointed as `person`, and
-- `business` is the installation's operating business.
create function backups.appointed_operator(person uuid, business text) returns boolean
  language sql stable set search_path = pg_catalog as $$
  select exists (select from backups.appointed p where p.login = session_user and p.person = $1)
    and exists (select from backups.installation i where i.operating_business = $2)
$$;
revoke execute on function backups.appointed_operator(uuid, text) from public;

-- Whether this login read the header of `archive` inside the freshness
-- window, and that archive is complete, taken at `taken_at`, with `sha256`
-- as its whole digest. A read is joined on the archive's own id, never a
-- time two archives can share.
create function backups.read_by_this_login(archive uuid, sha256 text, taken_at timestamptz)
  returns boolean
  language sql stable set search_path = pg_catalog as $$
  select $1 is not null and exists (
    select from backups.receipts r
    where r.action = 'backup read' and r.archive_id = $1 and r.part is null
      and r.actor = session_user
      and r.at > now() - make_interval(days => (select restore_days from backups.settings))
  ) and exists (
    select from backups.archives a
    where a.id = $1 and a.complete and a.sha256 = $2
      and date_trunc('milliseconds', a.taken_at) = $3
  )
$$;
revoke execute on function backups.read_by_this_login(uuid, text, timestamptz) from public;

-- The restore drill's receipts (ticket S0-3, lines C4 to C6 and C10). The
-- drill writes one row per run through `backups.record_drill`, as the restore
-- identity, and the row carries times, majors, counts, stage names, the
-- business, the archive's id and who recorded it only: no record data, key,
-- credential, fingerprint or path. The operations view reads the date of the
-- last passed drill from here (C55). `backups.restore_fresh()` answers only
-- yes or no: whether a drill passed inside the window
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
  -- Where it ran: on the machine, from the store, or on another host from a
  -- carried archive (restore-drill.mjs --drill --archive, then --record).
  ran_on text not null default 'staging machine'
    check (ran_on in ('staging machine', 'carried archive')),
  -- The archive the drill restored, by the store's own id, and the business
  -- it was recorded in; a pass and a carried drill always name the archive.
  archive_id uuid,
  business text,
  check (ran_on = 'staging machine' or archive_id is not null),
  check (outcome = 'failed' or (archive_id is not null and business is not null)),
  check ((outcome = 'passed') = (stage is null)),
  check (outcome = 'failed' or (archive_taken_at is not null and source_major is not null
    and target_major = production_major and tables > 0)),
  -- Stage timings in milliseconds, keyed by the drill's timed stages, and nothing else.
  check (jsonb_typeof(timings) = 'object' and not jsonb_path_exists(timings,
    '$.keyvalue() ? (!(@.key like_regex "^(fetch|open|start|restore|check)$") || @.value.type() != "number")'))
);
create trigger drills_append_only before update or delete or truncate on backups.drills
  for each statement execute function backups.receipts_append_only();

-- A drill on the machine. A failed one is anyone's with the restore identity;
-- a pass (the tenth to twelfth: the business, the archive's id and its whole
-- digest) only the appointed operator's own act, as above. It answers the
-- date of the last passed drill, this one included.
create function backups.record_drill(
  text, text, uuid, timestamptz, integer, integer, integer, integer, jsonb,
  text default null, uuid default null, text default null
) returns timestamptz
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if $1 = 'passed' and not (backups.appointed_operator($3, $10)
      and backups.read_by_this_login($11, $12, $4)) then
    raise exception 'a pass is the appointed operator''s own act, for an archive this login read'
      using errcode = '42501';
  end if;
  insert into backups.drills (outcome, stage, operator, archive_taken_at, production_major,
    source_major, target_major, tables, timings, actor, archive_id, business)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, session_user, $11, $10);
  return (select max(at) from backups.drills where outcome = 'passed');
end $$;
revoke execute on function backups.record_drill(text, text, uuid, timestamptz, integer, integer,
  integer, integer, jsonb, text, uuid, text) from public;
grant execute on function backups.record_drill(text, text, uuid, timestamptz, integer, integer,
  integer, integer, jsonb, text, uuid, text) to ops_astro_backup_restore;

-- A carried drill's receipt, brought back (restore-drill.mjs --record). It
-- names its archive by the store's own id (the eleventh, which --record takes
-- from the carried archive's facts), and is taken only against a read of that
-- same archive this same login made inside the freshness window. The archive
-- must be complete, taken at the receipt's time, and its digest the one of
-- the file the operator carried back (the tenth, which --record computes from
-- the file itself and never prints), so a receipt cannot be made up for an
-- archive the store never handed out, nor for another archive carried in its
-- place. A pass is the appointed operator's own act, in the operating
-- business (the twelfth), as above. Each archive is taken once per outcome,
-- so a receipt is never replayed to keep the restore fresh. The time the
-- store stamps is the time it was brought back.
create function backups.record_carried_drill(
  text, text, uuid, timestamptz, integer, integer, integer, integer, jsonb, text, uuid,
  text default null
) returns timestamptz
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if not backups.read_by_this_login($11, $10, $4)
      or ($1 = 'passed' and not backups.appointed_operator($3, $12)) then
    raise exception 'no read of that archive, with that digest, by this login inside the window, or not the appointed operator''s own pass'
      using errcode = '42501';
  end if;
  insert into backups.drills (outcome, stage, operator, archive_taken_at, production_major,
    source_major, target_major, tables, timings, actor, ran_on, archive_id, business)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, session_user, 'carried archive', $11, $12);
  return (select max(at) from backups.drills where outcome = 'passed');
end $$;
revoke execute on function backups.record_carried_drill(text, text, uuid, timestamptz, integer,
  integer, integer, integer, jsonb, text, uuid, text) from public;
grant execute on function backups.record_carried_drill(text, text, uuid, timestamptz, integer,
  integer, integer, integer, jsonb, text, uuid, text) to ops_astro_backup_restore;
create unique index drills_carried_once on backups.drills (archive_id, outcome)
  where ran_on = 'carried archive';

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
-- nothing more here: it holds no select to bypass with. The parts have no
-- grant at all: they are reached only through the functions above, and go
-- with their archive.
alter table backups.archives enable row level security;
alter table backups.archives force row level security;
create policy retention_sees on backups.archives for select to ops_astro_backup_retention using (true);
create policy retention_deletes_expired on backups.archives for delete to ops_astro_backup_retention
  using (taken_at < now() - make_interval(days => (select retention_days from backups.settings)));
