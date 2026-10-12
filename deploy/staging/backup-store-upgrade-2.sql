-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The second rule added to the backup store, run by the store's admin after
-- backup-store-upgrade-1.sql, from the restore runbook:
--
--   \i deploy/staging/backup-store-upgrade-2.sql
--
-- An appointment is read as it stands now. A repeatable-read or serializable
-- transaction keeps the snapshot it took first, so a login whose appointment
-- was removed after that could go on reading the appointment, and the parts
-- it allows, until the transaction ends. Each check therefore refuses any
-- transaction but read committed, where each statement reads what has
-- committed. Both functions are replaced whole, so the file can run more than
-- once.

create or replace function backups.appointed_operator(person uuid, business text) returns boolean
  language sql stable set search_path = pg_catalog as $$
  select current_setting('transaction_isolation') = 'read committed'
    and exists (select from backups.appointed p where p.login = session_user and p.person = $1)
    and exists (select from backups.installation i where i.operating_business = $2)
$$;
revoke execute on function backups.appointed_operator(uuid, text) from public;

create or replace function backups.read_part(archive uuid, seq integer)
  returns table (part_sha256 text, part bytea)
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  found_part backups.archive_parts;
  owner backups.archives;
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
