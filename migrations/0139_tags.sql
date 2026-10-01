-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0139 tags (MP-4-11, CS-4.19 to CS-4.21).
--
-- A business's tag vocabulary, and which of its tags each task carries. The
-- store is `packages/core-records/src/tasks/tags.ts`; the commands over it
-- are `tag.create` (`tag:write`), `task.add_tag` and `task.remove_tag`
-- (`task:write` on the task), and the vocabulary is the `tag.list` read.
--
-- **One name per business, whatever its case.** The unique index on the
-- lower-cased name is the rule, not a check a caller makes first: two creates
-- of "Urgent" and "urgent" at once meet at the index and the second inserts
-- nothing. A name is trimmed text of 1 to 40 characters with no control
-- character; the checks below hold that shape.
--
-- **A task takes a tag once.** The key of `task_tags` is the task and the
-- tag. Removing a tag from a task deletes that row only; the tag stays in the
-- vocabulary, and the audit chain keeps who added and removed it.

create table public.tags (
  business_id uuid        not null,
  id          uuid        not null,
  name        text        not null,
  actor_id    uuid        not null,
  created_at  timestamptz not null default now(),
  constraint tags_pkey primary key (id),
  constraint tags_tenant_id_key unique (business_id, id),
  constraint tags_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint tags_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint tags_name_shape check (
    char_length(name) between 1 and 40
    and name = btrim(name)
    and name !~ '[[:cntrl:]]'
  )
);

create unique index tags_one_name on public.tags (business_id, lower(name));

create table public.task_tags (
  business_id uuid        not null,
  task_id     uuid        not null,
  tag_id      uuid        not null,
  actor_id    uuid        not null,
  added_at    timestamptz not null default now(),
  constraint task_tags_pkey primary key (business_id, task_id, tag_id),
  constraint task_tags_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint task_tags_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint task_tags_tag_fkey foreign key (business_id, tag_id)
    references public.tags (business_id, id),
  constraint task_tags_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id)
);

create index task_tags_tag_idx on public.task_tags (business_id, tag_id);

alter table public.tags enable row level security;
alter table public.tags force row level security;
alter table public.task_tags enable row level security;
alter table public.task_tags force row level security;

create policy tenancy_tags on public.tags
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_tags on public.tags
  as permissive
  for all
  using (true)
  with check (true);

create policy tenancy_task_tags on public.task_tags
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_task_tags on public.task_tags
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.tags to ops_astro_app;
grant select, insert, delete on public.task_tags to ops_astro_app;
