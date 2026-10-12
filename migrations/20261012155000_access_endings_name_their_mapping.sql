-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An access ending names the mapping it ended (P06, #1435).
--
-- "Live elsewhere" (20261006213100, and `loginLiveElsewhere` in
-- shared-login.ts) read a login in another business as not live once any
-- ending there named the login. A login remapped there after its ending, to
-- another person or to an agent, was live but read as not live, so an ending
-- in this business banned its sign-in there too. An ending now names the
-- person and agent mapping rows it ended, read under the login's subject lock
-- (`access-end.ts`), the lock the mapping trigger takes before any live
-- mapping is written (20261006213000). A remap that began before the ending
-- either commits first and is named, or waits and commits after it and is
-- not. Live elsewhere is an active mapping that no ending names; no
-- timestamp decides it.
--
-- A mapping comes back as a new row, never by reactivating an old one, so a
-- mapping an ending named never goes live again. Nothing reactivates today.
--
-- An ending written before this names the person mapping that was live at its
-- `ended_at`: linked by then and not deactivated before it, when exactly one
-- was; otherwise none, which reads as live (doubt is a yes). No ending before
-- this ended an agent's mapping: `access.end` ends a person, and a login is
-- never a person's and an agent's in one business.

alter table public.access_endings
  add column person_mapping_id uuid,
  add column actor_mapping_id uuid,
  add constraint access_endings_person_mapping_fkey foreign key (business_id, person_mapping_id)
    references public.person_logins (business_id, id),
  add constraint access_endings_actor_mapping_fkey foreign key (business_id, actor_mapping_id)
    references public.actor_logins (business_id, id);

with named as (
  select e.id as ending_id, (array_agg(pl.id))[1] as mapping_id
    from public.access_endings e
    join public.person_logins pl
      on pl.business_id = e.business_id and pl.login_id = e.login_id
     and pl.person_id = e.person_id
     and pl.linked_at <= e.ended_at
     and (pl.deactivated_at is null or pl.deactivated_at >= e.ended_at)
   group by e.id
  having count(*) = 1)
update public.access_endings e
   set person_mapping_id = named.mapping_id
  from named
 where e.id = named.ending_id;

create function public.login_mapping_never_reactivated() returns trigger
  language plpgsql
  as $$
begin
  if new.active and not old.active then
    raise exception 'a deactivated % row is never made live again; map the login with a new row',
      tg_table_name
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.login_mapping_never_reactivated() from public;

create trigger person_logins_never_reactivated
  before update of active on public.person_logins
  for each row execute function public.login_mapping_never_reactivated();

create trigger actor_logins_never_reactivated
  before update of active on public.actor_logins
  for each row execute function public.login_mapping_never_reactivated();

-- Only the body changes: the signature, definer, settings, revoke and grant
-- are 20261005235557's, repeated here.
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
                                and m.active
                                and not exists (
                                  select 1 from public.access_endings e
                                   where e.business_id = l.business_id and e.login_id = l.id
                                     and e.person_mapping_id = m.id))
                     or exists (select 1 from public.actor_logins m
                                 where m.business_id = l.business_id and m.login_id = l.id
                                   and m.active
                                   and not exists (
                                     select 1 from public.access_endings e
                                      where e.business_id = l.business_id and e.login_id = l.id
                                        and e.actor_mapping_id = m.id))))
      from public.logins l0
     where l0.business_id = public.app_business_id()
       and l0.id = factor_login_live_elsewhere.login
       and l0.provider = 'supabase'), true)
$$;

revoke all on function public.factor_login_live_elsewhere(uuid) from public;
grant execute on function public.factor_login_live_elsewhere(uuid) to ops_astro_app;
