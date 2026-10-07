-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A login mapping claims its login with a new row version.
--
-- The mapping trigger waits on the shared login row and then reads the other
-- mapping table (0015, 20261006213000). It waited with `for update`, and a
-- row lock alone does not refresh a repeatable read or serializable snapshot.
-- Under Repeatable Read the second of two writers whose snapshots predate the
-- first commit would wait, read the other table as it was before the first
-- committed, find nothing and commit too: one login, mapped live as a person
-- and as an agent. The trigger now writes the login row unchanged instead, as
-- 0025 claims a cap. Under read committed the second writer waits and its next
-- read is a new snapshot that sees the first's mapping, as before; under
-- repeatable read or serializable it fails with `serialization_failure` and
-- the caller retries in a fresh snapshot. The write names no subject column,
-- so `logins_subject_is_fixed` does not fire. The subject lock, the check and
-- the error are 20261006213000's, unchanged, and the revoke is repeated.

create or replace function public.login_is_a_person_or_an_agent() returns trigger
  language plpgsql
  as $$
declare
  conflicting text;
  login_subject text;
begin
  -- The subject's lock, first: every other taker takes it before any row lock.
  if new.active then
    select l.subject into login_subject
      from public.logins l
     where l.business_id = new.business_id and l.id = new.login_id;
    perform pg_advisory_xact_lock(hashtextextended(
      'second-factor-subject:' || encode(sha256(convert_to(login_subject, 'UTF8')), 'hex'), 0))
      where login_subject is not null;
  end if;

  -- The serialisation point. Both mapping tables reference this row, so both
  -- writers write it, unchanged; the second one blocks here until the first
  -- commits, and only then reads the other table, in a snapshot that sees the
  -- first's mapping or not at all.
  update public.logins l
     set created_at = l.created_at
   where l.business_id = new.business_id and l.id = new.login_id;

  if tg_table_name = 'actor_logins' then
    select 'a person' into conflicting
      from public.person_logins pl
     where pl.business_id = new.business_id and pl.login_id = new.login_id and pl.active
     limit 1;
  else
    select 'an agent' into conflicting
      from public.actor_logins al
     where al.business_id = new.business_id and al.login_id = new.login_id and al.active
     limit 1;
  end if;
  if conflicting is not null and new.active then
    raise exception 'login % is already mapped to %', new.login_id, conflicting
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.login_is_a_person_or_an_agent() from public;
