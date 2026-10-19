-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35 (capture half, #2011, part A): a page revision under review and the
-- captures asked of it.
--
-- A review is a record on its task. Its holder is the task's client, or no
-- party for the business's own site (R6), so the grant filter
-- (`core-records/src/site/covering.ts`) judges it as it judges a live
-- correction. A page review names one bound page of that holder; a media
-- review (U89, #2038) names none, so the page is required only for
-- `kind = 'page'`. Revisions are numbered under the review's row lock and
-- carry a digest. A capture is one row per width; the worker's claim and land,
-- and the pictures they keep, are part B's.

create table public.reviews (
  business_id         uuid        not null,
  id                  uuid        not null,
  task_id             uuid        not null,
  party_id            uuid,
  kind                text        not null default 'page',
  page_url            text,
  path                text,
  revision_count      integer     not null default 0,
  opened_by_actor_id  uuid        not null,
  opened_by_person_id uuid        not null,
  delegation_id       uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint reviews_pkey primary key (id),
  constraint reviews_tenant_id_key unique (business_id, id),
  constraint reviews_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint reviews_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint reviews_opened_by_actor_fkey foreign key (business_id, opened_by_actor_id)
    references public.actors (business_id, id),
  constraint reviews_opened_by_person_fkey foreign key (business_id, opened_by_person_id)
    references public.people (business_id, id),
  constraint reviews_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint reviews_kind_known check (kind in ('page', 'media')),
  constraint reviews_page_named
    check (kind <> 'page' or (page_url is not null and path is not null)),
  constraint reviews_revision_count_counts check (revision_count >= 0)
);

create unique index reviews_one_per_page
  on public.reviews (business_id, task_id, page_url, path) where kind = 'page';
create index reviews_party_idx on public.reviews (business_id, party_id);

create table public.review_revisions (
  business_id          uuid        not null,
  id                   uuid        not null,
  review_id            uuid        not null,
  number               integer     not null,
  digest               text        not null,
  source_revision      text,
  created_by_actor_id  uuid        not null,
  created_by_person_id uuid        not null,
  delegation_id        uuid,
  created_at           timestamptz not null default now(),
  constraint review_revisions_pkey primary key (id),
  constraint review_revisions_tenant_id_key unique (business_id, id),
  constraint review_revisions_numbered unique (business_id, review_id, number),
  constraint review_revisions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_revisions_review_fkey foreign key (business_id, review_id)
    references public.reviews (business_id, id),
  constraint review_revisions_actor_fkey foreign key (business_id, created_by_actor_id)
    references public.actors (business_id, id),
  constraint review_revisions_person_fkey foreign key (business_id, created_by_person_id)
    references public.people (business_id, id),
  constraint review_revisions_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint review_revisions_number_positive check (number >= 1)
);

create table public.review_captures (
  business_id        uuid        not null,
  id                 uuid        not null,
  revision_id        uuid        not null,
  width              integer     not null,
  state              text        not null default 'requested',
  asked_by_actor_id  uuid        not null,
  asked_by_person_id uuid        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint review_captures_pkey primary key (id),
  constraint review_captures_tenant_id_key unique (business_id, id),
  constraint review_captures_one_per_width unique (business_id, revision_id, width),
  constraint review_captures_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_captures_revision_fkey foreign key (business_id, revision_id)
    references public.review_revisions (business_id, id),
  constraint review_captures_actor_fkey foreign key (business_id, asked_by_actor_id)
    references public.actors (business_id, id),
  constraint review_captures_person_fkey foreign key (business_id, asked_by_person_id)
    references public.people (business_id, id),
  constraint review_captures_width_known check (width in (1480, 390)),
  constraint review_captures_state_known check (state in ('requested', 'claimed', 'landed'))
);

alter table public.reviews enable row level security;
alter table public.reviews force row level security;
alter table public.review_revisions enable row level security;
alter table public.review_revisions force row level security;
alter table public.review_captures enable row level security;
alter table public.review_captures force row level security;

create policy tenancy_reviews on public.reviews
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_reviews on public.reviews
  as permissive for all using (true) with check (true);

create policy tenancy_review_revisions on public.review_revisions
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_revisions on public.review_revisions
  as permissive for all using (true) with check (true);

create policy tenancy_review_captures on public.review_captures
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_captures on public.review_captures
  as permissive for all using (true) with check (true);

-- A revision is never changed and a review only counts its revisions; part B moves captures.
grant select, insert on public.reviews to ops_astro_app;
grant update (revision_count, updated_at) on public.reviews to ops_astro_app;
grant select, insert on public.review_revisions to ops_astro_app;
grant select, insert on public.review_captures to ops_astro_app;
