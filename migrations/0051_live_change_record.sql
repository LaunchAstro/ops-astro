-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0051 the live change record (C4, CS-15.19).
--
-- The writes that emit 0035's invalidations also stamp the task they name
-- here, in the same transaction, so *changes since* (API-4) reads the same
-- record the live channel carries: one row a task, overwritten by each change,
-- holding who and what never, only which task and the writing transaction.
-- The transaction id is the point: a reader's next point is the oldest
-- transaction still open when it read, so a write open at the point is read
-- next time rather than skipped. A rolled-back write leaves no stamp.
-- Rows are upserted in task order, so two bulk writes lock them alike.

create table public.live_changes (
  business_id  uuid        not null,
  subject_kind text        not null,
  subject_id   uuid        not null,
  changed_xid  xid8        not null default pg_current_xact_id(),
  changed_at   timestamptz not null default now(),
  constraint live_changes_pkey primary key (business_id, subject_kind, subject_id),
  constraint live_changes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint live_changes_kind check (subject_kind = 'task')
);

create index live_changes_since_idx on public.live_changes (business_id, changed_xid);

alter table public.live_changes enable row level security;
alter table public.live_changes force row level security;

create policy tenancy_live_changes on public.live_changes
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_live_changes on public.live_changes
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.live_changes to ops_astro_app;

create or replace function public.live_task_topic()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  insert into public.live_changes as c (business_id, subject_kind, subject_id)
       values (new.business_id, 'task', new.task_id)
  on conflict (business_id, subject_kind, subject_id)
  do update set changed_xid = pg_current_xact_id(), changed_at = now()
        where c.changed_xid <> pg_current_xact_id();
  perform pg_notify('ops_astro_live', new.business_id::text || ':task:' || new.task_id::text);
  return null;
end;
$$;

create or replace function public.live_record_topics()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  insert into public.live_changes as c (business_id, subject_kind, subject_id)
       select topics.business_id, 'task', topics.task::uuid
         from (select distinct changed.business_id,
                      coalesce(changed.data ->> 'task', changed.id::text) as task
                 from changed) as topics
        where topics.task ~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
        order by 3
  on conflict (business_id, subject_kind, subject_id)
  do update set changed_xid = pg_current_xact_id(), changed_at = now()
        where c.changed_xid <> pg_current_xact_id();
  perform pg_notify('ops_astro_live', topic)
     from (select distinct changed.business_id::text || ':task:'
                  || coalesce(changed.data ->> 'task', changed.id::text) as topic
             from changed) as topics;
  return null;
end;
$$;
