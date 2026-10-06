-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The map read models' four writers (20261004091449 WF-1, the refresh as
-- 20261005125527 left it) run as their own role, not the owner's, as the
-- pickup path does (20261004040200). Owned by the owner, every write they made
-- to public.map_summaries and public.map_frontier was the owner's, so the
-- made-up guard on staging (S0-1, scripts/ops/made-up-install.ts) logged each
-- map edit as a write it cannot vouch for and the next seed run refused the
-- database. As this role, the guard and row security judge those writes as
-- they judge the application's. The functions' bodies, search paths, definer
-- setting and revokes do not change; every policy they meet applies to every
-- role, and the owner is under the same forced row security, so they read and
-- write the same rows as before.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_map_path') then
    create role ops_astro_map_path nologin nosuperuser nocreatedb nocreaterole noreplication
      nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'ops_astro_map_path' and (rolcanlogin
      or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    alter role ops_astro_map_path nologin nosuperuser nocreatedb nocreaterole noreplication
      nobypassrls;
  end if;
  -- Changing a function's owner needs the migrator able to act as that role.
  execute format('grant ops_astro_map_path to %I', current_user);
end $$;

revoke all on all tables in schema public from ops_astro_map_path;
revoke all on all functions in schema public from ops_astro_map_path;
grant usage on schema public to ops_astro_map_path;
grant execute on function public.app_business_id() to ops_astro_map_path;
-- What the refresh and the three triggers read to find a map and count it.
grant select on public.record_types, public.records, public.record_links,
  public.map_components, public.map_versions
  to ops_astro_map_path;
-- The two read models: the summary is upserted, the frontier rewritten whole.
grant select, insert, update, delete on public.map_summaries to ops_astro_map_path;
grant select, insert, delete on public.map_frontier to ops_astro_map_path;

-- A new owner needs CREATE on its schema at the change (0001 revokes it from
-- everyone), so the role holds it for these statements and no longer.
grant create on schema public to ops_astro_map_path;
alter function public.map_summary_refresh(uuid) owner to ops_astro_map_path;
alter function public.map_summary_on_record() owner to ops_astro_map_path;
alter function public.map_summary_on_map_part() owner to ops_astro_map_path;
alter function public.map_summary_on_link() owner to ops_astro_map_path;
revoke create on schema public from ops_astro_map_path;

-- The owner keeps nothing on them beyond what owning gave it before: each stays
-- revoked from public, and the refresh is called only by the three triggers,
-- which now run as its owner.
revoke all on function public.map_summary_refresh(uuid) from public;
revoke all on function public.map_summary_on_record() from public;
revoke all on function public.map_summary_on_map_part() from public;
revoke all on function public.map_summary_on_link() from public;

comment on role ops_astro_map_path is
  'The map read models'' role: it owns the summary and frontier writers, reads what they '
  'count and writes map_summaries and map_frontier under row security. No one logs in as it.';
