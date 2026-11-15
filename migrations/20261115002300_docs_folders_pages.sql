-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Docs, the thin slice (#2493 piece 1, round DECISIONS 127): a business's folder tree, its
-- pages as Markdown text, and one version row for every write.
--
-- The store is `packages/core-records/src/docs/store.ts`; the commands over it are
-- `docs.create_folder`, `docs.create_page` and `docs.update_page`, each `docs:write` on the
-- business. Docs are the business's own: only a business-wide grant covers them, so a grant
-- held at one client reaches no folder or page.
--
-- **A folder sits in one business, under a parent of the same business or at the top.** The
-- parent key is the tenant pair, so a parent from another business cannot be named. A folder
-- is never moved here, so the tree has no cycle. One name per parent, whatever its case: the
-- unique index is the rule, not a check a caller makes first.
--
-- **Every write appends a version.** A page's `version` is the number of its newest row in
-- `docs_page_versions`, which keeps the title and body of every write. An update names the
-- version it read and is refused if the page moved on, so no write overwrites one it never saw.
-- Version rows are inserted and read, never changed.

create table public.docs_folders (
  business_id   uuid        not null,
  id            uuid        not null,
  parent_id     uuid,
  name          text        not null,
  created_by_actor_id uuid  not null,
  created_at    timestamptz not null default now(),
  constraint docs_folders_pkey primary key (id),
  constraint docs_folders_tenant_id_key unique (business_id, id),
  constraint docs_folders_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint docs_folders_parent_fkey foreign key (business_id, parent_id)
    references public.docs_folders (business_id, id),
  constraint docs_folders_creator_fkey foreign key (business_id, created_by_actor_id)
    references public.actors (business_id, id),
  constraint docs_folders_not_own_parent check (parent_id is distinct from id),
  constraint docs_folders_name_shape check (
    char_length(name) between 1 and 120
    and name = btrim(name)
    and name !~ '[[:cntrl:]]'
  )
);

create unique index docs_folders_one_name
  on public.docs_folders (business_id, coalesce(parent_id, business_id), lower(name));

create table public.docs_pages (
  business_id   uuid        not null,
  id            uuid        not null,
  folder_id     uuid        not null,
  title         text        not null,
  body          text        not null,
  version       integer     not null,
  created_by_actor_id uuid  not null,
  updated_by_actor_id uuid  not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint docs_pages_pkey primary key (id),
  constraint docs_pages_tenant_id_key unique (business_id, id),
  constraint docs_pages_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint docs_pages_folder_fkey foreign key (business_id, folder_id)
    references public.docs_folders (business_id, id),
  constraint docs_pages_creator_fkey foreign key (business_id, created_by_actor_id)
    references public.actors (business_id, id),
  constraint docs_pages_updater_fkey foreign key (business_id, updated_by_actor_id)
    references public.actors (business_id, id),
  constraint docs_pages_version_positive check (version >= 1),
  constraint docs_pages_title_shape check (
    char_length(title) between 1 and 200
    and title = btrim(title)
    and title !~ '[[:cntrl:]]'
  ),
  constraint docs_pages_body_bounded check (char_length(body) <= 200000)
);

create index docs_pages_folder_idx on public.docs_pages (business_id, folder_id);

create table public.docs_page_versions (
  business_id   uuid        not null,
  page_id       uuid        not null,
  number        integer     not null,
  title         text        not null,
  body          text        not null,
  actor_id      uuid        not null,
  created_at    timestamptz not null default now(),
  constraint docs_page_versions_pkey primary key (business_id, page_id, number),
  constraint docs_page_versions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint docs_page_versions_page_fkey foreign key (business_id, page_id)
    references public.docs_pages (business_id, id),
  constraint docs_page_versions_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint docs_page_versions_number_positive check (number >= 1),
  constraint docs_page_versions_body_bounded check (char_length(body) <= 200000)
);

alter table public.docs_folders enable row level security;
alter table public.docs_folders force row level security;
alter table public.docs_pages enable row level security;
alter table public.docs_pages force row level security;
alter table public.docs_page_versions enable row level security;
alter table public.docs_page_versions force row level security;

create policy tenancy_docs_folders on public.docs_folders
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_docs_folders on public.docs_folders
  as permissive for all using (true) with check (true);

create policy tenancy_docs_pages on public.docs_pages
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_docs_pages on public.docs_pages
  as permissive for all using (true) with check (true);

create policy tenancy_docs_page_versions on public.docs_page_versions
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_docs_page_versions on public.docs_page_versions
  as permissive for all using (true) with check (true);

-- A folder is made once. A page's title, body, version and last writer move; nothing else.
-- A version row is written once and never changed.
grant select, insert on public.docs_folders to ops_astro_app;
grant select, insert on public.docs_pages to ops_astro_app;
grant update (title, body, version, updated_by_actor_id, updated_at)
  on public.docs_pages to ops_astro_app;
grant select, insert on public.docs_page_versions to ops_astro_app;
