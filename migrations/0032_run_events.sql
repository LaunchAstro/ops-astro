-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0032 the run's progress record (T2a).
--
-- Each transition of a run is its own row, written by pickup and hand-back in
-- their own transactions, so a refusal leaves none; append-only at the server,
-- as `handback_reports` is (0018). One composite key ties an event to its run
-- and the run's task, which gains no run pointer (specification 14.4).
-- `position` is the task's order across its runs and the read's cursor: both
-- writers hold the task lock, and the unique index is the second barrier.
-- `task_revision_at_request` is filled by the server on insert, so no writer
-- can forget or forge it; runs planned before 0032 keep null.

alter table public.planned_runs add column task_revision_at_request bigint;

alter table public.planned_runs
  add constraint planned_runs_task_run_key unique (business_id, id, task_id);

create or replace function public.planned_runs_revision_at_request()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  select r.revision into new.task_revision_at_request
    from public.records r
   where r.business_id = new.business_id and r.id = new.task_id;
  return new;
end;
$$;

revoke all on function public.planned_runs_revision_at_request() from public;

create trigger planned_runs_revision_at_request
  before insert on public.planned_runs
  for each row execute function public.planned_runs_revision_at_request();

create table public.run_events (
  business_id     uuid        not null,
  id              uuid        not null,
  run_id          uuid        not null,
  task_id         uuid        not null,
  position        bigint      not null,
  kind            text        not null,
  lease_id        uuid        not null,
  attempt_id      uuid        not null,
  actor_id        uuid        not null,
  detail          jsonb       not null,
  created_at      timestamptz not null default now(),
  constraint run_events_pkey primary key (id),
  constraint run_events_tenant_id_key unique (business_id, id),
  constraint run_events_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint run_events_run_fkey foreign key (business_id, run_id, task_id)
    references public.planned_runs (business_id, id, task_id),
  constraint run_events_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint run_events_attempt_fkey foreign key (business_id, attempt_id)
    references public.attempts (business_id, id),
  constraint run_events_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint run_events_kind_known check (kind in ('claimed', 'handed_back')),
  constraint run_events_position_positive check (position > 0),
  constraint run_events_detail_object check (jsonb_typeof(detail) = 'object')
);

create unique index run_events_task_position_idx
  on public.run_events (business_id, task_id, position);

create index run_events_business_idx on public.run_events (business_id);

create index run_events_run_idx on public.run_events (business_id, run_id);

alter table public.run_events enable row level security;
alter table public.run_events force row level security;

create policy tenancy_run_events on public.run_events
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_run_events on public.run_events
  as permissive
  for all
  using (true)
  with check (true);

create or replace function public.run_events_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'run_events is append only: event % cannot be %',
    old.id, lower(tg_op);
end;
$$;

revoke all on function public.run_events_append_only() from public;

create trigger run_events_no_update
  before update or delete on public.run_events
  for each row execute function public.run_events_append_only();

grant select, insert on public.run_events to ops_astro_app;
