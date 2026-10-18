-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The third rule added to the backup store, run by the store's admin after
-- backup-store-upgrade-2.sql, from the restore runbook:
--
--   \i deploy/staging/backup-store-upgrade-3.sql
--
-- A part is read in two steps (#742). The restore command asks the operator
-- gate before each part, but the store cannot see the operator's sign-in, so
-- a sign-in that ended after that ask and before the store ran the read still
-- had the part handed out. Now `backups.read_part` hands the part out sealed
-- under a key of its own (AES-256 in CBC mode, a random key per read, so a
-- zero IV) and writes no receipt. `backups.release_part` hands out that key
-- and writes the part-read receipt; the command asks the gate between the two,
-- with the operator's grant held from that ask until the key arrives
-- (scripts/ops/restore-drill.mjs). A key goes once, to the login that read the
-- part, while the installation still appoints it, and only within
-- `part_key_life` of the read. The file can run more than once.

-- pgcrypto beside dblink, out of every identity's reach; the functions below
-- name it there, so one installed in another schema stops the upgrade.
do $$ begin
  if not exists (select from pg_extension where extname = 'pgcrypto') then
    create extension pgcrypto schema backups_audit;
  elsif not exists (
    select from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'backups_audit'
  ) then
    raise exception 'pgcrypto is installed in another schema of the store: move it to backups_audit first';
  end if;
end $$;

-- The key of each part a login has read and not yet released. No identity is
-- granted anything on it: only the two functions below reach it.
create table if not exists backups.part_keys (
  login name not null,
  archive_id uuid not null references backups.archives on delete cascade,
  seq integer not null,
  key bytea not null check (length(key) = 32),
  issued_at timestamptz not null default now(),
  primary key (login, archive_id, seq)
);

-- How long after its read a part's key can be released.
create or replace function backups.part_key_life() returns interval
  language sql immutable set search_path = pg_catalog as $$ select interval '10 minutes' $$;
revoke execute on function backups.part_key_life() from public;

-- One part of a complete archive, with the digest the store took of it,
-- sealed under a key only `release_part` hands out; checked as before, and it
-- writes no receipt. A read again replaces the part's earlier key.
create or replace function backups.read_part(archive uuid, seq integer)
  returns table (part_sha256 text, part bytea)
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  found_part backups.archive_parts;
  owner backups.archives;
  sealing bytea := backups_audit.gen_random_bytes(32);
begin
  if current_setting('transaction_isolation') <> 'read committed'
      or not exists (select from backups.appointed p where p.login = session_user) then
    raise exception 'not the installation''s appointed operator' using errcode = '42501';
  end if;
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
  delete from backups.part_keys k
  where k.login = session_user and k.issued_at <= now() - backups.part_key_life();
  insert into backups.part_keys (login, archive_id, seq, key)
  values (session_user, owner.id, found_part.seq, sealing)
  -- By its constraint: a column list would read `seq` as this function's own argument.
  on conflict on constraint part_keys_pkey do update set key = excluded.key, issued_at = now();
  return query select found_part.sha256,
    backups_audit.encrypt(found_part.chunk, sealing, 'aes-cbc/pad:pkcs');
end $$;
revoke execute on function backups.read_part(uuid, integer) from public;

-- The key of part `seq` of `archive`, which this login read within
-- `part_key_life`, once; only while the installation still appoints the login,
-- read as it stands now. The key goes and the part-read receipt is written in
-- one statement on a connection of its own (dblink), committed before the key
-- is returned, so a caller that rolls back keeps the receipt and gets no
-- second release.
create or replace function backups.release_part(archive uuid, seq integer) returns bytea
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  released bytea;
begin
  if current_setting('transaction_isolation') <> 'read committed'
      or not exists (select from backups.appointed p where p.login = session_user) then
    raise exception 'not the installation''s appointed operator' using errcode = '42501';
  end if;
  select decode(t.key, 'hex') into released from backups_audit.dblink(
    format('dbname=''%s'' user=''%s''', current_database(), current_user),
    format(
      'with gone as (delete from backups.part_keys k where k.login = %1$L and k.archive_id = %2$L and k.seq = %3$s '
      'and k.issued_at > now() - backups.part_key_life() '
      'and exists (select from backups.appointed p where p.login = %1$L) returning k.archive_id, k.seq, k.key), '
      'logged as (insert into backups.receipts (action, archive_id, taken_at, bytes, actor, part) '
      'select %4$L, a.id, a.taken_at, length(p.chunk), %1$L, p.seq from gone g '
      'join backups.archives a on a.id = g.archive_id '
      'join backups.archive_parts p on p.archive_id = g.archive_id and p.seq = g.seq) '
      'select encode(key, ''hex'') from gone',
      session_user, $1, $2, 'backup read'
    )
  ) as t(key text);
  if released is null then
    raise exception 'no key of that part for this login' using errcode = '42501';
  end if;
  return released;
end $$;
revoke execute on function backups.release_part(uuid, integer) from public;
grant execute on function backups.release_part(uuid, integer) to ops_astro_backup_restore;
