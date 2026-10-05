-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Trace retention's asks (AW-13, catalogue #475).
--
-- The trace store applies a delete whenever it likes: after a timeout, after
-- the pass that asked has failed, after the run's fresh events have gone out
-- again. So the ask is written before the delete, in the transaction that
-- chose the run, with the export's cursor that choice read: every event of
-- the run up to that place was behind it. An ask is owed until a batch
-- confirms its run at that place or later; while it is owed, a read back
-- that finds the trace gone sends the run's events after that place again
-- and confirms the ask, in one transaction. The rows are facts: append only.

create table public.trace_expiry_asks (
  business_id  uuid        not null,
  id           uuid        not null,
  run_id       uuid        not null,
  after_tx     xid8        not null,
  after_id     uuid        not null,
  asked_at     timestamptz not null default now(),
  constraint trace_expiry_asks_pkey primary key (id),
  constraint trace_expiry_asks_tenant_id_key unique (business_id, id),
  constraint trace_expiry_asks_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id)
);

create index trace_expiry_asks_business_run_idx
  on public.trace_expiry_asks (business_id, run_id);

alter table public.trace_expiry_asks enable row level security;
alter table public.trace_expiry_asks force row level security;

create policy tenancy_trace_expiry_asks on public.trace_expiry_asks
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_trace_expiry_asks on public.trace_expiry_asks
  as permissive
  for all
  using (true)
  with check (true);

create or replace function public.trace_expiry_asks_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'trace_expiry_asks is append only: ask % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.trace_expiry_asks_append_only() from public;

create trigger trace_expiry_asks_no_update
  before update or delete on public.trace_expiry_asks
  for each row execute function public.trace_expiry_asks_append_only();

grant select, insert on public.trace_expiry_asks to ops_astro_app;

-- A batch confirms its runs at the place their asks read: every event of a
-- run up to it is gone from the store. A batch from before this migration
-- has no place and confirms nothing: its runs are asked once more, a delete
-- of what is already gone, and confirmed at a place. The owed check looks a
-- run up in the batches' runs, so they get an index. A pass whose owed reads
-- the store did not answer records those runs, and the next pass reads them
-- after the rest.
alter table public.trace_expiry_batches
  add column after_tx xid8,
  add column after_id uuid,
  add column unanswered_run_ids uuid[] not null default '{}',
  add constraint trace_expiry_batches_place_whole
    check ((after_tx is null) = (after_id is null));

create index trace_expiry_batches_runs_idx
  on public.trace_expiry_batches using gin (expired_run_ids);

create index trace_expiry_batches_unanswered_idx
  on public.trace_expiry_batches using gin (unanswered_run_ids);

-- A body the target refuses as too large (413) is a gap of its own.
alter table public.trace_export_gaps
  drop constraint trace_export_gaps_code_known,
  add constraint trace_export_gaps_code_known check (code in (
    'target_unreachable', 'target_redirect', 'target_timeout', 'target_oversized_reply',
    'target_oversized_body', 'target_malformed_reply', 'target_refused', 'target_forbidden'));

alter table public.trace_expiry_batches
  drop constraint trace_expiry_batches_code_known,
  add constraint trace_expiry_batches_code_known check (code is null or code in (
    'target_unreachable', 'target_redirect', 'target_timeout', 'target_oversized_reply',
    'target_oversized_body', 'target_malformed_reply', 'target_refused', 'target_forbidden',
    'expiry_unconfirmed'));

-- One export per business at a time (#963): an export takes a lease on its
-- business's cursor row before it reads, renews it before each body and gives
-- it up when it advances or records its gap. Another export takes it only
-- once it has expired, so two exports never deliver at once.
alter table public.trace_export_cursors
  add column lease_holder uuid,
  add column lease_until timestamptz,
  add constraint trace_export_cursors_lease_whole
    check ((lease_holder is null) = (lease_until is null));
