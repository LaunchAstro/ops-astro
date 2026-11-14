-- SPDX-License-Identifier: AGPL-3.0-only
--
-- U89's media store (#2038, store half of C73): a media review's asset,
-- uploaded in parts straight to an object store behind the storage seam.
--
-- A task has at most one media review. An asset row is written when its
-- upload starts, with what the caller declared and the store's upload id; its
-- object key is `business/review/revision/asset`, ids only, the revision id
-- planned then. The revision is written only when the store's size and digest
-- match the declared ones, so a completed asset names its revision and any
-- other state names none.

create unique index reviews_one_media_per_task
  on public.reviews (business_id, task_id) where kind = 'media';

create table public.review_media_assets (
  business_id          uuid        not null,
  id                   uuid        not null,
  review_id            uuid        not null,
  planned_revision_id  uuid        not null,
  revision_id          uuid,
  kind                 text        not null,
  declared_type        text        not null,
  declared_bytes       bigint      not null,
  declared_codec       text,
  declared_digest      text        not null,
  object_key           text        not null,
  upload_id            text        not null,
  state                text        not null default 'started',
  created_by_actor_id  uuid        not null,
  created_by_person_id uuid        not null,
  delegation_id        uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint review_media_assets_pkey primary key (id),
  constraint review_media_assets_tenant_id_key unique (business_id, id),
  constraint review_media_assets_one_per_revision unique (business_id, planned_revision_id),
  constraint review_media_assets_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_media_assets_review_fkey foreign key (business_id, review_id)
    references public.reviews (business_id, id),
  constraint review_media_assets_revision_fkey foreign key (business_id, revision_id)
    references public.review_revisions (business_id, id),
  constraint review_media_assets_actor_fkey foreign key (business_id, created_by_actor_id)
    references public.actors (business_id, id),
  constraint review_media_assets_person_fkey foreign key (business_id, created_by_person_id)
    references public.people (business_id, id),
  constraint review_media_assets_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint review_media_assets_kind_known check (kind in ('video', 'audio', 'image', 'pdf')),
  constraint review_media_assets_state_known
    check (state in ('started', 'completed', 'abandoned')),
  constraint review_media_assets_bytes_positive check (declared_bytes > 0),
  constraint review_media_assets_digest_shape check (declared_digest ~ '^sha256:[0-9a-f]{64}$'),
  constraint review_media_assets_completed_names_its_revision
    check ((state = 'completed') = (revision_id is not null)
       and (revision_id is null or revision_id = planned_revision_id))
);

create index review_media_assets_review_idx on public.review_media_assets (business_id, review_id);

alter table public.review_media_assets enable row level security;
alter table public.review_media_assets force row level security;

create policy tenancy_review_media_assets on public.review_media_assets
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_media_assets on public.review_media_assets
  as permissive for all using (true) with check (true);

-- What was declared and where it is stored never change; only the upload's state moves.
grant select, insert on public.review_media_assets to ops_astro_app;
grant update (state, revision_id, updated_at) on public.review_media_assets to ops_astro_app;
