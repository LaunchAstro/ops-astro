-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0039 the outage report (T3e2). One outage that drops many runs is one
-- report, not one alert per run: the cause (T3e1's drop cause), its window
-- from the first drop to the last, and each run it dropped with whether the
-- work came back. Drops of one cause in one business join the open report
-- while they keep arriving inside its window; after the window the report is
-- closed and the next drop opens another. At most one report is open per
-- business and cause, which the unique index holds against concurrent drops.
--
-- Both tables are the team's, read through `task.queue`. The worker holds
-- nothing on either. No function is created and the gate engine's tables are
-- not touched.

create table public.outage_reports (
  business_id  uuid        not null,
  id           uuid        not null,
  cause        text        not null,
  opened_at    timestamptz not null default now(),
  last_drop_at timestamptz not null default now(),
  closed_at    timestamptz,
  constraint outage_reports_pkey primary key (id),
  constraint outage_reports_tenant_id_key unique (business_id, id),
  constraint outage_reports_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint outage_reports_cause_known
    check (cause in ('provider_unavailable', 'connection_lost', 'worker_lost')),
  constraint outage_reports_window_ordered
    check (last_drop_at >= opened_at and (closed_at is null or closed_at >= last_drop_at))
);

create unique index outage_reports_one_open_idx
  on public.outage_reports (business_id, cause) where closed_at is null;

create table public.outage_runs (
  business_id uuid    not null,
  outage_id   uuid    not null,
  attempt_id  uuid    not null,
  run_id      uuid    not null,
  task_id     uuid    not null,
  reactivated boolean not null,
  constraint outage_runs_pkey primary key (business_id, attempt_id),
  constraint outage_runs_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint outage_runs_outage_fkey foreign key (business_id, outage_id)
    references public.outage_reports (business_id, id),
  constraint outage_runs_attempt_fkey foreign key (business_id, attempt_id)
    references public.attempts (business_id, id),
  constraint outage_runs_run_fkey foreign key (business_id, run_id, task_id)
    references public.planned_runs (business_id, id, task_id)
);

create index outage_runs_outage_idx on public.outage_runs (business_id, outage_id);

alter table public.outage_reports enable row level security;
alter table public.outage_reports force row level security;
alter table public.outage_runs enable row level security;
alter table public.outage_runs force row level security;

create policy tenancy_outage_reports on public.outage_reports
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_outage_reports on public.outage_reports
  as permissive
  for all
  using (true)
  with check (true);

create policy tenancy_outage_runs on public.outage_runs
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_outage_runs on public.outage_runs
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.outage_reports to ops_astro_app;
grant select, insert on public.outage_runs to ops_astro_app;
