-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent login is live elsewhere too, and a login's subject is fixed
-- (C58 and C59, D3-FIX2).
--
-- One provider user can be a person's login in alpha and an agent's login in
-- bravo. The shared-login check asked only `person_logins`, so ending the
-- person in alpha banned the provider user and with it bravo's live agent.
-- `factor_login_live_elsewhere` (20261003003537) now counts an active mapping
-- in either table, as `loginLiveElsewhere` (shared-login.ts) does. Only the
-- body changes: the signature, definer, settings, revoke and grant are
-- 20261003003537's, repeated here.
--
-- An ending holds its subject's lock from its last shared check to its stamp,
-- and every mapping write takes that lock (20261004044057). Changing a mapped
-- login's subject or provider took no lock and fired no mapping trigger, so
-- bravo could point a live login at the subject alpha was banning, after
-- alpha's check. Nothing changes either column once a login is written (the
-- seeds and scan-login insert; no product path updates `public.logins`), so
-- both are now fixed, for every role, the owner included.

create or replace function public.factor_login_live_elsewhere(login uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
as $$
  select coalesce((
    select exists (
             select 1
               from public.logins l
              where l.provider = l0.provider and l.subject = l0.subject
                and l.business_id <> l0.business_id
                and (exists (select 1 from public.person_logins m
                              where m.business_id = l.business_id and m.login_id = l.id
                                and m.active)
                     or exists (select 1 from public.actor_logins m
                                 where m.business_id = l.business_id and m.login_id = l.id
                                   and m.active))
                and not exists (
                  select 1 from public.access_endings e
                   where e.business_id = l.business_id and e.login_id = l.id))
      from public.logins l0
     where l0.business_id = public.app_business_id()
       and l0.id = factor_login_live_elsewhere.login
       and l0.provider = 'supabase'), true)
$$;

revoke all on function public.factor_login_live_elsewhere(uuid) from public;
grant execute on function public.factor_login_live_elsewhere(uuid) to ops_astro_app;

create function public.logins_subject_is_fixed() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'logins: a login''s provider and subject are fixed once written'
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.logins_subject_is_fixed() from public;

create trigger logins_subject_is_fixed
  before update of provider, subject on public.logins
  for each row
  when (new.provider is distinct from old.provider or new.subject is distinct from old.subject)
  execute function public.logins_subject_is_fixed();
