-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0015 one login is a person's or an agent's, and concurrency cannot make it
-- both.
--
-- 0008 states the rule and enforces it with two triggers, each reading the
-- other mapping table before permitting its own write. Read committed is what
-- makes that insufficient: two transactions, one mapping a login to a person
-- and one mapping the same login to an agent, each run their `select` before
-- either has committed, each see nothing, and both commit. The per-table
-- unique indexes never meet, because they are on different tables, and the
-- foreign keys to `public.logins` take a shared lock that two readers hold at
-- once. The login then resolves down both paths, which is precisely what 0008
-- exists to prevent.
--
-- The fix is a serialisation point both writers must pass, and there is
-- already exactly one row both of them are about: the login itself. Taking
-- `for update` on `public.logins` before the cross-table check makes the
-- second transaction wait for the first to commit, and its check then reads
-- the first's committed row and raises. One commits; the other is refused
-- `unique_violation`, the same code an in-table duplicate gets, because it is
-- the same fact.
--
-- `create or replace` rather than a new function, so the two triggers 0008
-- created keep pointing at it and nothing about the trigger definitions
-- changes. The replacement resets the default PUBLIC execute grant, so the
-- revoke 0008 carries is repeated here; it is not decoration.
--
-- Safe on the live tables: 12 `person_logins` rows and 0 `actor_logins` rows,
-- and this migration reads and writes none of them. Only the function body
-- changes, and only for writes made after it.

create or replace function public.login_is_a_person_or_an_agent() returns trigger
  language plpgsql
  as $$
declare
  conflicting text;
  locked uuid;
begin
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
