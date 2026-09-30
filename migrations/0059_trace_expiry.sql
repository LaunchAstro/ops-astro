-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0059 trace retention's record (AW-13).
--
-- The product is the trace store's deletion authority (contract 7.3). Each
-- retention batch is one row: the window it applied, how many runs it asked
-- to delete, the runs whose absence it read back and confirmed, and the gap
-- code when the batch did not finish (a failed delete, or a delete the store
-- answered with success but did not do). A run is expired once a batch
-- confirmed it after its last event; one not confirmed is simply asked again
-- by the next pass. The rows are facts: append only, like the export's gaps.

create table public.trace_expiry_batches (
  business_id      uuid        not null,
  id               uuid        not null,
  window_days      integer     not null,
  runs             integer     not null,
  expired_run_ids  uuid[]      not null,
  code             text,
  recorded_at      timestamptz not null default now(),
  constraint trace_expiry_batches_pkey primary key (id),
  constraint trace_expiry_batches_tenant_id_key unique (business_id, id),
  constraint trace_expiry_batches_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint trace_expiry_batches_window_positive check (window_days > 0),
  constraint trace_expiry_batches_runs_counted
    check (runs > 0 and cardinality(expired_run_ids) <= runs),
  constraint trace_expiry_batches_code_known check (code is null or code in (
    'target_unreachable', 'target_redirect', 'target_timeout', 'target_oversized_reply',
    'target_malformed_reply', 'target_refused', 'target_forbidden', 'expiry_unconfirmed')),
  constraint trace_expiry_batches_whole_or_gap
    check (code is not null or cardinality(expired_run_ids) = runs)
);

create index trace_expiry_batches_business_idx
  on public.trace_expiry_batches (business_id, recorded_at);

alter table public.trace_expiry_batches enable row level security;
alter table public.trace_expiry_batches force row level security;

create policy tenancy_trace_expiry_batches on public.trace_expiry_batches
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_trace_expiry_batches on public.trace_expiry_batches
  as permissive
  for all
  using (true)
  with check (true);

create or replace function public.trace_expiry_batches_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'trace_expiry_batches is append only: batch % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.trace_expiry_batches_append_only() from public;

create trigger trace_expiry_batches_no_update
  before update or delete on public.trace_expiry_batches
  for each row execute function public.trace_expiry_batches_append_only();

grant select, insert on public.trace_expiry_batches to ops_astro_app;
