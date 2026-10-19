-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35 (capture half, #2011): a page revision under review, its captures and
-- the pictures they keep.
--
-- A review is a record on its task. Its holder is the task's client, or no
-- party for the business's own site (R6), read from the task in the opening
-- statement, so the grant filter (`core-records/src/site/covering.ts`) judges
-- it as it judges a live correction. A page review names one bound page of
-- that holder; a media review (U89, #2038) names none, so the page is required
-- only for `kind = 'page'`. Revisions are numbered from one under the review's
-- row lock and carry a digest: the page revision's, or a media asset's
-- checksum. A capture is one row per width, asked by a person or a delegated
-- agent, claimed by one worker lease and landed under that lease alone.
--
-- Pictures are kept in `storage_objects`, the bounded database provider
-- behind the storage seam (`core-records/src/review/storage.ts`): bytes by id,
-- business scoped, capped in size here as well as in the provider. A row
-- names an object by id only, never a path.

create table public.storage_objects (
  business_id uuid        not null,
  id          uuid        not null,
  digest      text        not null,
  byte_count  integer     not null,
  body        bytea       not null,
  created_at  timestamptz not null default now(),
  constraint storage_objects_pkey primary key (id),
  constraint storage_objects_tenant_id_key unique (business_id, id),
  constraint storage_objects_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint storage_objects_bounded
    check (byte_count between 1 and 524288 and octet_length(body) = byte_count)
);

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
  lease_id           uuid,
  fence              bigint,
  observation        jsonb,
  picture_id         uuid,
  picture_digest     text,
  landed_at          timestamptz,
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
  constraint review_captures_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint review_captures_picture_fkey foreign key (business_id, picture_id)
    references public.storage_objects (business_id, id),
  constraint review_captures_width_known check (width in (1480, 390)),
  constraint review_captures_state_known check (state in ('requested', 'claimed', 'landed')),
  constraint review_captures_claim_whole
    check ((state = 'requested') = (lease_id is null) and (lease_id is null) = (fence is null)),
  constraint review_captures_land_whole check (
    (state = 'landed') = (landed_at is not null)
    and (landed_at is null) = (observation is null)
    and (landed_at is null) = (picture_id is null)
    and (picture_id is null) = (picture_digest is null)
  )
);

create index review_captures_lease_idx on public.review_captures (business_id, lease_id);

alter table public.storage_objects enable row level security;
alter table public.storage_objects force row level security;
alter table public.reviews enable row level security;
alter table public.reviews force row level security;
alter table public.review_revisions enable row level security;
alter table public.review_revisions force row level security;
alter table public.review_captures enable row level security;
alter table public.review_captures force row level security;

create policy tenancy_storage_objects on public.storage_objects
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_storage_objects on public.storage_objects
  as permissive for all using (true) with check (true);

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

-- A picture is written once and removed only through the seam; a revision is
-- never changed; a review only counts its revisions; a capture only moves.
grant select, insert, delete on public.storage_objects to ops_astro_app;
grant select, insert, update on public.reviews to ops_astro_app;
grant select, insert on public.review_revisions to ops_astro_app;
grant select, insert, update on public.review_captures to ops_astro_app;

-- A capture moves requested -> claimed -> landed, a claim may pass to a later
-- lease only while the capture is not landed, and a landed capture keeps what
-- it landed. The revision and the width are fixed.
create or replace function public.review_captures_moves()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if (new.business_id, new.id, new.revision_id, new.width, new.asked_by_actor_id,
      new.asked_by_person_id, new.created_at)
     is distinct from
     (old.business_id, old.id, old.revision_id, old.width, old.asked_by_actor_id,
      old.asked_by_person_id, old.created_at) then
    raise exception 'review_captures_moves: capture % keeps its revision and width', old.id;
  end if;
  if old.state = 'landed' then
    raise exception 'review_captures_moves: capture % is landed', old.id;
  end if;
  if not ((old.state in ('requested', 'claimed') and new.state = 'claimed')
          or (old.state = 'claimed' and new.state = 'landed'
              and new.lease_id = old.lease_id and new.fence = old.fence)) then
    raise exception 'review_captures_moves: capture % cannot move from % to %',
      old.id, old.state, new.state;
  end if;
  return new;
end;
$$;

revoke all on function public.review_captures_moves() from public;

create trigger review_captures_moves
  before update on public.review_captures
  for each row execute function public.review_captures_moves();
