-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A live login mapping waits for its subject's lock (C58, OW-028.2).
--
-- An access ending holds `second-factor-subject:<digest>`, the installation-
-- wide lock on a provider subject (`lockLoginSubject`, second-factor.ts), from
-- its live-elsewhere check through the provider ban to its stamp. A mapping
-- written meanwhile in another business took only its own login's row lock
-- (0015), so it could commit a live login of the subject being banned. Every
-- mapping writer, the application and the seed scripts alike, passes through
-- this trigger, so an active mapping now takes the same key first, before the
-- row lock: it waits for the ending's commit, and an ending that starts after
-- it sees it. The key is the one the TypeScript takes, the SHA-256 hex of the
-- subject's UTF-8 bytes. 0015's serialisation point is unchanged, and the
-- revoke is repeated because the replacement resets the PUBLIC grant.

create or replace function public.login_is_a_person_or_an_agent() returns trigger
  language plpgsql
  as $$
declare
  conflicting text;
  locked uuid;
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
  -- writers name it; the second one blocks here until the first commits, and
  -- only then reads the other table. Locking before the check is the whole
  -- correction -- checking first and locking afterwards would leave the same
  -- window open.
  select l.id into locked
    from public.logins l
   where l.business_id = new.business_id and l.id = new.login_id
     for update;

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
