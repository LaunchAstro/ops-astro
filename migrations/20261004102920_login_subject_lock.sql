-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261004102920 no sign-in is mapped to a person while its cleanup runs.
-- `scripts/security/scan-login.mjs remove` deletes the scan sign-in at the
-- provider once no other business maps it to a person (OW-069.1). A mapping
-- committed between that check and the delete was left live against a
-- deleted account. The login subject lock closes it: a transaction advisory
-- lock keyed on hashtextextended(provider || ':' || subject, 0). The cleanup
-- holds it exclusively from its check through the provider delete. A write
-- that leaves a person_logins row live takes it shared, or is refused
-- (lock_not_available) when the cleanup holds it: it never waits, so it never
-- commits after the account is gone. A cleanup that starts while a mapping is
-- being written waits for that commit, and its check then finds the mapping.

create function public.person_login_subject_not_in_cleanup() returns trigger
  language plpgsql
  as $$
declare
  subject_key text;
begin
  select l.provider || ':' || l.subject into subject_key
    from public.logins l
   where l.business_id = new.business_id and l.id = new.login_id;
  if new.active and subject_key is not null
     and not pg_try_advisory_xact_lock_shared(hashtextextended(subject_key, 0)) then
    raise exception 'login % is being removed at its provider', new.login_id
      using errcode = 'lock_not_available';
  end if;
  return new;
end;
$$;

revoke execute on function public.person_login_subject_not_in_cleanup() from public;

create trigger person_logins_subject_not_in_cleanup
  before insert or update on public.person_logins
  for each row execute function public.person_login_subject_not_in_cleanup();
