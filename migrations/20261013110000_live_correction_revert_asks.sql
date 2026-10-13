-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C80: the ask to revert a live correction.
--
-- The configured approver asks, once, that a live correction be reverted. The
-- ask is one row, and its id is what the worker's revert step names when it
-- proposes that step. The command decides who may ask, under the correction's
-- lock and the approver setting's, and the unique key holds "once". An ask is
-- written once and never changed or removed: the application has no update or
-- delete on it.

create table public.live_correction_revert_asks (
  business_id         uuid        not null,
  id                  uuid        not null,
  correction_id       uuid        not null,
  asked_by_actor_id   uuid        not null,
  asked_by_person_id  uuid        not null,
  created_at          timestamptz not null default now(),
  constraint live_correction_revert_asks_pkey primary key (id),
  constraint live_correction_revert_asks_tenant_id_key unique (business_id, id),
  constraint live_correction_revert_asks_once unique (business_id, correction_id),
  constraint live_correction_revert_asks_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint live_correction_revert_asks_correction_fkey foreign key (business_id, correction_id)
    references public.live_corrections (business_id, id),
  constraint live_correction_revert_asks_actor_fkey foreign key (business_id, asked_by_actor_id)
    references public.actors (business_id, id),
  constraint live_correction_revert_asks_person_fkey foreign key (business_id, asked_by_person_id)
    references public.people (business_id, id)
);

alter table public.live_correction_revert_asks enable row level security;
alter table public.live_correction_revert_asks force row level security;

create policy tenancy_live_correction_revert_asks on public.live_correction_revert_asks
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_live_correction_revert_asks on public.live_correction_revert_asks
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.live_correction_revert_asks to ops_astro_app;
