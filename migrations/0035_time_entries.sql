-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0035 time entries (MP-4-6, CS-4.1, CS-4.28 to CS-4.31).
--
-- One row per stretch of a person's time on a task: running while `ended_at`
-- is null, logged once it has `minutes`. The store is
-- `packages/core-records/src/tasks/time.ts`; the commands over it are
-- MP-4-6's command step.
--
-- **One running timer per person.** The partial unique index below is the
-- rule, not a check a caller makes first: two starts at once for one person
-- meet at the index, and the second inserts nothing (`on conflict do
-- nothing`), so a person never has two timers running whatever the timing.
--
-- **Elapsed time is never dropped.** A stopped or logged entry carries at
-- least one whole minute, and an entry is either running (no end, no minutes)
-- or finished (both): the checks below hold that shape. A delete is a mark,
-- `deleted_at`, so a deleted entry stays evidence of what was recorded.

create table public.time_entries (
  business_id uuid        not null,
  id          uuid        not null,
  task_id     uuid        not null,
  person_id   uuid        not null,
  actor_id    uuid        not null,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  minutes     integer,
  note        text        not null default '',
  ad_hoc      boolean     not null,
  source      text        not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint time_entries_pkey primary key (id),
  constraint time_entries_tenant_id_key unique (business_id, id),
  constraint time_entries_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint time_entries_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint time_entries_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint time_entries_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint time_entries_source_known check (source in ('timer', 'log')),
  constraint time_entries_shape
    check ((ended_at is null) = (minutes is null)),
  constraint time_entries_minutes_whole check (minutes is null or minutes between 1 and 1440),
  constraint time_entries_note_bounded check (char_length(note) <= 500)
);

create unique index time_entries_one_running
  on public.time_entries (business_id, person_id)
  where ended_at is null and deleted_at is null;
create index time_entries_task_idx on public.time_entries (business_id, task_id);

alter table public.time_entries enable row level security;
alter table public.time_entries force row level security;

create policy tenancy_time_entries on public.time_entries
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_time_entries on public.time_entries
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.time_entries to ops_astro_app;
