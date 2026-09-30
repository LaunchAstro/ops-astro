-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0051 C55: the privacy incident record (SP-24), shown on the operations view.
--
-- The breach runbook's first step opens one of these on day 0: what happened,
-- when it was found, who found it, which clients and people, and what kinds of
-- information. Every later step is written against it. The 30-day assessment
-- limit runs from `found_at` and is derived from it where it is read
-- (`operations/privacy-incidents.ts`), so no stored date can drift from it.
--
-- These words can describe people and what happened to their information, so
-- they live here and nowhere else: not in `records` (no share, search or
-- export reaches this table), and not in the audit chain, which holds a digest
-- of the act. Recording one is `privacy:manage`; reading them is
-- `operations:read`. Neither is ever an agent's.

create table public.privacy_incidents (
  business_id        uuid        not null,
  id                 uuid        not null,
  what_happened      text        not null,
  found_at           timestamptz not null,
  found_by           text        not null,
  affected           text        not null,
  information_kinds  text[]      not null,
  status             text        not null default 'open',
  recorded_at        timestamptz not null default now(),
  recorded_by_actor  uuid        not null,
  constraint privacy_incidents_pkey primary key (id),
  constraint privacy_incidents_tenant_id_key unique (business_id, id),
  constraint privacy_incidents_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint privacy_incidents_actor_fkey foreign key (business_id, recorded_by_actor)
    references public.actors (business_id, id),
  constraint privacy_incidents_what_present
    check (length(btrim(what_happened)) between 1 and 4000),
  constraint privacy_incidents_found_by_present
    check (length(btrim(found_by)) between 1 and 200),
  constraint privacy_incidents_affected_present
    check (length(btrim(affected)) between 1 and 2000),
  constraint privacy_incidents_kinds_known check (
    cardinality(information_kinds) between 1 and 7
    and information_kinds <@ array['contact', 'identity', 'financial', 'health',
                                   'credentials', 'client-files', 'other']::text[]
  ),
  constraint privacy_incidents_found_not_after_recorded
    check (found_at <= recorded_at + interval '5 minutes'),
  constraint privacy_incidents_status_known check (status in ('open', 'closed'))
);

create index privacy_incidents_by_found
  on public.privacy_incidents (business_id, found_at desc);

alter table public.privacy_incidents enable row level security;
alter table public.privacy_incidents force row level security;

create policy tenancy_privacy_incidents on public.privacy_incidents
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_privacy_incidents on public.privacy_incidents
  as permissive
  for all
  using (true)
  with check (true);

-- Recorded and later moved on, never deleted.
grant select, insert, update on public.privacy_incidents to ops_astro_app;
