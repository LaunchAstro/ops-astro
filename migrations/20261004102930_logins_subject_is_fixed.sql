-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261004102930 a login's provider and subject are fixed once written.
-- The login subject lock (20261004102920) guards writes to person_logins
-- only. Changing a mapped login's subject took no lock and fired no mapping
-- trigger, so another business could point a live login at the subject
-- scan-login was removing, after its check, and keep a mapping to a deleted
-- account. Nothing changes either column once a login is written (the seeds
-- and scan-login insert; no product path updates `public.logins`), so both
-- are now fixed, for every role, the owner included. The function and trigger
-- are lane D3's (20261004071400), written so either copy may run first.

create or replace function public.logins_subject_is_fixed() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'logins: a login''s provider and subject are fixed once written'
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.logins_subject_is_fixed() from public;

drop trigger if exists logins_subject_is_fixed on public.logins;
create trigger logins_subject_is_fixed
  before update of provider, subject on public.logins
  for each row
  when (new.provider is distinct from old.provider or new.subject is distinct from old.subject)
  execute function public.logins_subject_is_fixed();
