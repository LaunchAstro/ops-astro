-- SPDX-License-Identifier: AGPL-3.0-only
--
-- R6, part 1 (#1688): a business's own site, bound to the business itself and
-- not to a party (decision R6-S2-20261018 in docs/current-decisions.md).
--
-- The business's own site is its one site row with no party. Each site and
-- page is keyed by its holder: the client it belongs to, or the business
-- itself where it names no client. Clients can never take the business's
-- identity, so the two holders never meet, and no party record is the
-- business.
--
-- A correction on the business's own site carries no party. The grant filter
-- (`core-records/src/site/covering.ts`) then counts only a business-wide
-- grant, so a grant scoped to a party, even one naming the business's
-- identity, reaches none of it. The request's insert still reads the task's
-- client in its own statement, so a task with no client stores a request only
-- on its own business's page, and a client's task only on its client's.

-- No client is the business.
alter table public.clients
  add constraint clients_not_the_business check (id <> business_id);

-- Sites and pages, keyed by their holder. The holder is kept by a trigger,
-- not generated: a write may name it, and the trigger sets it from the party
-- and the business whatever it named, so no row holds another.
create or replace function public.party_site_holder()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  new.holder := coalesce(new.party_id, new.business_id);
  return new;
end;
$$;

revoke all on function public.party_site_holder() from public;

alter table public.party_site_pages drop constraint party_site_pages_site_fkey;
alter table public.party_sites drop constraint party_sites_pkey;

alter table public.party_sites alter column party_id drop not null;
alter table public.party_sites add column holder uuid;
update public.party_sites set holder = coalesce(party_id, business_id);
alter table public.party_sites alter column holder set not null;
alter table public.party_sites
  add constraint party_sites_holder_whole check (holder = coalesce(party_id, business_id));
alter table public.party_sites
  add constraint party_sites_pkey primary key (business_id, holder);
create trigger party_sites_holder
  before insert or update on public.party_sites
  for each row execute function public.party_site_holder();

alter table public.party_site_pages alter column party_id drop not null;
alter table public.party_site_pages add column holder uuid;
-- The backfill is the one update a page takes: `party_site_pages_fixed` refuses every other.
alter table public.party_site_pages disable trigger party_site_pages_fixed;
update public.party_site_pages set holder = coalesce(party_id, business_id);
alter table public.party_site_pages enable trigger party_site_pages_fixed;
alter table public.party_site_pages alter column holder set not null;
alter table public.party_site_pages
  add constraint party_site_pages_holder_whole check (holder = coalesce(party_id, business_id));
alter table public.party_site_pages
  add constraint party_site_pages_not_the_business check (party_id <> business_id);
alter table public.party_site_pages
  add constraint party_site_pages_site_fkey foreign key (business_id, holder)
    references public.party_sites (business_id, holder);
create trigger party_site_pages_holder
  before insert or update on public.party_site_pages
  for each row execute function public.party_site_holder();

-- A correction on the business's own site names no party.
alter table public.live_corrections alter column party_id drop not null;

-- As 20261013051839, for either holder: a null party is the business's own site.
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
     where c.business_id = business and c.party_id is not distinct from party
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

create or replace function public.party_site_pages_held()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.party_sites s
   where s.business_id = old.business_id and s.holder = old.holder
   for no key update;
  if public.party_site_under_correction(old.business_id, old.party_id) then
    raise exception 'party_site_pages_held: an open correction names this site'
      using errcode = 'P0001', constraint = 'party_site_pages_held';
  end if;
  return old;
end;
$$;
