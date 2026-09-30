-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0046 the diagnostic trace export (AW-13). The exporter reads `run_events`
-- by a cursor of its own, outside the execution path, and sends a
-- content-free copy of each event to a trace target. Nothing here is read by
-- a run, and nothing a run writes waits on it: the durable record is the
-- buffer, and a stopped, killed or failing exporter only falls behind.
--
-- * The copy is registered in the copy register (0042) before it is first
--   materialised, as class `diagnostic_trace`, keyed by the run, retained as
--   a trace (30 days, AW-13's retention line).
-- * `trace_export_cursors`: one row per business, the last event delivered,
--   by the event's (created_at, id), which orders every event in the
--   business; `run_events.position` orders one task's only.
-- * `trace_export_gaps`: a delivery that did not land (a target unreachable,
--   a redirect, a timeout, an oversized or malformed reply), recorded with a
--   fixed code and the cursor it was sent from. Append only: a gap is a fact.

alter table public.copy_registrations drop constraint copy_registrations_class_known;
alter table public.copy_registrations add constraint copy_registrations_class_known
  check (copy_class in ('outbound_prompt', 'diagnostic_trace'));
alter table public.copy_registrations drop constraint copy_registrations_retention_known;
alter table public.copy_registrations add constraint copy_registrations_retention_known
  check (retention_class in ('transient', 'run', 'record', 'trace'));

create table public.trace_export_cursors (
  business_id  uuid        not null,
  after_at     timestamptz,
  after_id     uuid,
  updated_at   timestamptz not null default now(),
  constraint trace_export_cursors_pkey primary key (business_id),
  constraint trace_export_cursors_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint trace_export_cursors_whole check ((after_at is null) = (after_id is null))
);

alter table public.trace_export_cursors enable row level security;
alter table public.trace_export_cursors force row level security;

create policy tenancy_trace_export_cursors on public.trace_export_cursors
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_trace_export_cursors on public.trace_export_cursors
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.trace_export_cursors to ops_astro_app;

create table public.trace_export_gaps (
  business_id  uuid        not null,
  id           uuid        not null,
  code         text        not null,
  from_at      timestamptz,
  from_id      uuid,
  events       integer     not null,
  recorded_at  timestamptz not null default now(),
  constraint trace_export_gaps_pkey primary key (id),
  constraint trace_export_gaps_tenant_id_key unique (business_id, id),
  constraint trace_export_gaps_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint trace_export_gaps_code_known check (code in (
    'target_unreachable', 'target_redirect', 'target_timeout', 'target_oversized_reply',
    'target_malformed_reply', 'target_refused', 'target_forbidden')),
  constraint trace_export_gaps_events_positive check (events > 0)
);

create index trace_export_gaps_business_idx on public.trace_export_gaps (business_id);

alter table public.trace_export_gaps enable row level security;
alter table public.trace_export_gaps force row level security;

create policy tenancy_trace_export_gaps on public.trace_export_gaps
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_trace_export_gaps on public.trace_export_gaps
  as permissive
  for all
  using (true)
  with check (true);

create or replace function public.trace_export_gaps_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'trace_export_gaps is append only: gap % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.trace_export_gaps_append_only() from public;

create trigger trace_export_gaps_no_update
  before update or delete on public.trace_export_gaps
  for each row execute function public.trace_export_gaps_append_only();

grant select, insert on public.trace_export_gaps to ops_astro_app;
