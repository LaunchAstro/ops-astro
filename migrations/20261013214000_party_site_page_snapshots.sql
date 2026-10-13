-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C80: the text of each bound page's source file, as the correction job last
-- read it, so the sidebar can find a correction's file without the API ever
-- holding a site credential.
--
-- One row per bound page, keyed as the page is: it goes when the page is
-- unbound. The job writes it; the application only reads it, through the
-- sidebar's site read, which answers it only for a page of the task's own
-- client and only to a caller who could request a correction there. A stale
-- row is safe: the publish is preconditioned on the file as it stands.

create table public.party_site_page_snapshots (
  business_id      uuid        not null,
  page_url         text        not null,
  source_revision  text        not null,
  source_text      text        not null,
  taken_at         timestamptz not null default now(),
  constraint party_site_page_snapshots_pkey primary key (business_id, page_url),
  constraint party_site_page_snapshots_page_fkey foreign key (business_id, page_url)
    references public.party_site_pages (business_id, page_url) on delete cascade,
  constraint party_site_page_snapshots_revision_present check (source_revision <> ''),
  constraint party_site_page_snapshots_text_size check (octet_length(source_text) <= 262144)
);

alter table public.party_site_page_snapshots enable row level security;
alter table public.party_site_page_snapshots force row level security;

create policy tenancy_party_site_page_snapshots on public.party_site_page_snapshots
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_party_site_page_snapshots on public.party_site_page_snapshots
  as permissive
  for all
  using (true)
  with check (true);

grant select on public.party_site_page_snapshots to ops_astro_app;
