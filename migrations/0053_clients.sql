-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0053 clients (C32, CS-2.15). The client record: one row per client of the
-- business, the party a party-scoped grant names in `grants.scope_id` and a
-- task names in its `client` link (`records.uuid_7`, written only by
-- `task.set_party`). A client is an organisation the business works for, not
-- a person: its people stay on `people`, one list (RC-22).
--
-- A client is made by `client.create` and never deleted. Neither the grant nor
-- the task link carries a foreign key to it, for the reasons 0003 and 0006
-- give (`scope_id` is opaque, the slot is generic), so the owning operations
-- check a client is of this business before they write its id: `access.grant`
-- and `task.set_party`.
--
-- One name per business in any letter case, so two rows never read as one
-- client on a screen.

create table public.clients (
  business_id          uuid        not null,
  id                   uuid        not null,
  name                 text        not null,
  created_at           timestamptz not null default now(),
  created_by_actor_id  uuid        not null,
  constraint clients_pkey primary key (id),
  constraint clients_tenant_id_key unique (business_id, id),
  constraint clients_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint clients_created_by_fkey foreign key (business_id, created_by_actor_id)
    references public.actors (business_id, id),
  constraint clients_name_present check (
    length(name) between 1 and 200 and name = btrim(name)
  )
);

create unique index clients_one_name on public.clients (business_id, lower(name));

alter table public.clients enable row level security;
alter table public.clients force row level security;

create policy tenancy_clients on public.clients
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_clients on public.clients
  as permissive
  for all
  using (true)
  with check (true);

-- No update and no delete: a client is written once. A rename is its own
-- tracked action when a ticket asks for one.
grant select, insert on public.clients to ops_astro_app;
