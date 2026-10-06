-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent login is live elsewhere too (C58 and C59, D3-FIX2).
--
-- One provider user can be a person's login in alpha and an agent's login in
-- bravo. The shared-login check asked only `person_logins`, so ending the
-- person in alpha banned the provider user and with it bravo's live agent.
-- `factor_login_live_elsewhere` (20261005235557) now counts an active mapping
-- in either table, as `loginLiveElsewhere` (shared-login.ts) does. Only the
-- body changes: the signature, definer, settings, revoke and grant are
-- 20261005235557's, repeated here.
--
-- D3-FIX2's other half, a login's provider and subject fixed once written so
-- no mapped login is pointed at a subject an ending is banning, is main's
-- 20261004102930 (`logins_subject_is_fixed`), which holds the same function
-- and trigger; it is not repeated here.

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
