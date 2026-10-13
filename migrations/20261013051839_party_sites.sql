-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C80: each client's site, the one place a party is mapped to its pages and
-- their source files.
--
-- A live correction names a page and its file. The request's insert joins the
-- page row of the task's own client, so a page another client holds, or one no
-- client holds, stores nothing. The runner reads the same rows for its binding.
--
-- A site is bound once in the installation: its repository (owner and name,
-- in the lower case GitHub treats every spelling as) and its hosting project
-- id are unique across every business, so no business can bind a site another
-- holds and route its corrections there. A page names one client in a
-- business; several pages may be built from one file.
--
-- A client's site is frozen while any correction of that client is open
-- (requested, approved, accepted, unknown or live, or cancelled after its
-- decision): no page is unbound and the
-- providers do not change, so a decision, a publish and a revert all act on
-- the site the request named, and a live change keeps its revert. The guard
-- share-locks those corrections, so one being written is waited for and judged
-- as it commits. A page is never updated: it is unbound and bound again.

create table public.party_sites (
  business_id          uuid        not null,
  party_id             uuid        not null,
  repository           text        not null,
  default_branch       text        not null,
  project              text        not null,
  changed_by_actor_id  uuid        not null,
  changed_at           timestamptz not null default now(),
  revision             integer     not null default 1,
  constraint party_sites_pkey primary key (business_id, party_id),
  constraint party_sites_party_fkey foreign key (business_id, party_id)
    references public.clients (business_id, id),
  constraint party_sites_changed_by_fkey foreign key (business_id, changed_by_actor_id)
    references public.actors (business_id, id),
  constraint party_sites_repository_shape check (
    repository ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'
  ),
  constraint party_sites_branch_present check (default_branch <> ''),
  constraint party_sites_project_present check (project <> '')
);

create unique index party_sites_repository_key on public.party_sites (repository);
create unique index party_sites_project_key on public.party_sites (project);

create table public.party_site_pages (
  business_id  uuid not null,
  party_id     uuid not null,
  page_url     text not null,
  path         text not null,
  constraint party_site_pages_pkey primary key (business_id, page_url),
  constraint party_site_pages_site_fkey foreign key (business_id, party_id)
    references public.party_sites (business_id, party_id),
  constraint party_site_pages_present check (page_url <> '' and path <> '')
);

alter table public.party_sites enable row level security;
alter table public.party_sites force row level security;
alter table public.party_site_pages enable row level security;
alter table public.party_site_pages force row level security;

create policy tenancy_party_sites on public.party_sites
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_party_sites on public.party_sites
  as permissive
  for all
  using (true)
  with check (true);

create policy tenancy_party_site_pages on public.party_site_pages
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_party_site_pages on public.party_site_pages
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.party_sites to ops_astro_app;
grant update (repository, default_branch, project, changed_by_actor_id, changed_at, revision)
  on public.party_sites to ops_astro_app;
grant select, insert, delete on public.party_site_pages to ops_astro_app;
-- Only so a request can key-share lock the page it names: a page is never
-- updated (unbind it and bind it again), which `party_site_pages_fixed` holds.
grant update (path) on public.party_site_pages to ops_astro_app;

create or replace function public.party_site_pages_fixed()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'party_site_pages_fixed: a page is unbound and bound again, never changed';
end;
$$;

revoke all on function public.party_site_pages_fixed() from public;

create trigger party_site_pages_fixed
  before update on public.party_site_pages
  for each row execute function public.party_site_pages_fixed();

-- Whether a correction of this client is open: requested, approved, accepted,
-- unknown or live, or cancelled after its decision (its publish may have gone
-- out, and its result can still move it to unknown). Share-locks every
-- correction it reads, so one being written is waited for. Invoker: the
-- caller's own tenancy holds.
create or replace function public.party_site_under_correction(business uuid, party uuid)
  returns boolean
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
declare
  open_one boolean := false;
  each_one record;
begin
  for each_one in
    select c.state, c.decided_at from public.live_corrections c
     where c.business_id = business and c.party_id = party
     for share
  loop
    if each_one.state in ('requested', 'approved', 'accepted', 'unknown', 'live')
       or (each_one.state = 'cancelled' and each_one.decided_at is not null) then
      open_one := true;
    end if;
  end loop;
  return open_one;
end;
$$;

revoke all on function public.party_site_under_correction(uuid, uuid) from public;
grant execute on function public.party_site_under_correction(uuid, uuid) to ops_astro_app;

-- A page's delete takes its site row first, so a request in flight on any page
-- of the client (which share-locks that row) is waited for, then refuses while
-- a correction of the client is open.
create or replace function public.party_site_pages_held()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.party_sites s
   where s.business_id = old.business_id and s.party_id = old.party_id
   for no key update;
  if public.party_site_under_correction(old.business_id, old.party_id) then
    raise exception 'party_site_pages_held: an open correction names this client''s site'
      using errcode = 'P0001', constraint = 'party_site_pages_held';
  end if;
  return old;
end;
$$;

revoke all on function public.party_site_pages_held() from public;

create trigger party_site_pages_held
  before delete on public.party_site_pages
  for each row execute function public.party_site_pages_held();

create or replace function public.party_sites_held()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if (new.business_id, new.party_id) is distinct from (old.business_id, old.party_id) then
    raise exception 'party_sites_held: a site keeps its client';
  end if;
  if (new.repository, new.default_branch, new.project)
       is distinct from (old.repository, old.default_branch, old.project)
     and public.party_site_under_correction(old.business_id, old.party_id) then
    raise exception 'party_sites_held: an open correction names this site'
      using errcode = 'P0001', constraint = 'party_sites_held';
  end if;
  return new;
end;
$$;

revoke all on function public.party_sites_held() from public;

create trigger party_sites_held
  before update on public.party_sites
  for each row execute function public.party_sites_held();
